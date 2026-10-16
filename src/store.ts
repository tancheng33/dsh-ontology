/**
 * The thin IO layer between the durable domain and the pure reasoning core:
 * it projects the three tables into a {@link GraphView}, applies validated
 * writes, and enforces the capacity guards. All rules live in `ontology.ts`;
 * this module only decides what reaches the medium.
 * @module dsh-ontology/store
 */

import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { factIndex, factKey, likelyDuplicates, validateEntityInput, validateFactInput, validateClassInput, validateRedefinition, validateRelationInput } from './ontology.ts'
import type { ClassInput, EntityInput, FactInput, RelationInput } from './ontology.ts'
import type { OntologyDomainSpec } from './spec.ts'
import { FACT_KEY_SEPARATOR } from './types.ts'
import type { Entity, Fact, GraphTable, GraphView, RangeKind, Term, Violation } from './types.ts'

/** Deployment limits the store enforces before writing. */
export interface StoreLimits {
  readonly maxEntities: number
  readonly maxFacts: number
  /** Whether a TBox violation rejects the write or is recorded on the fact. */
  readonly strict: boolean
}

/** Outcome of one attempted write. */
export interface WriteOutcome {
  readonly ok: boolean
  readonly violations: readonly Violation[]
}

/** An accepted write. */
const ACCEPTED: WriteOutcome = { ok: true, violations: [] }

/**
 * A {@link GraphTable} over a live storage table. Storage reads are synchronous
 * from memory and `entries()` is already a snapshot, so no copy is needed; the
 * adapter exists so a graph view costs nothing to hand out.
 */
class TableView<V> implements GraphTable<V> {
  readonly #table: KvTable<string, V>

  constructor(table: KvTable<string, V>) {
    this.#table = table
  }

  get size(): number {
    return this.#table.size
  }

  get(key: string): V | undefined {
    return this.#table.get(key)
  }

  has(key: string): boolean {
    return this.#table.get(key) !== undefined
  }

  keys(): Iterable<string> {
    return this.#table.keys()
  }

  * values(): Iterable<V> {
    for (const [, value] of this.#table.entries()) yield value
  }

  entries(): Iterable<[string, V]> {
    return this.#table.entries()
  }
}

/**
 * A live ontology over one open storage domain.
 *
 * Reads see the tables through one {@link GraphView} object per write
 * generation. The view itself copies nothing; its identity is what the pure
 * core keys its memoized entailment and indexes on, so a burst of queries
 * between two writes derives once. Writes go through the same validators the
 * tools expose, so nothing reaches the medium unchecked.
 */
export class OntologyStore {
  readonly #terms: KvTable<string, Term>
  readonly #entities: KvTable<string, Entity>
  readonly #facts: KvTable<string, Fact>
  readonly #limits: StoreLimits
  #cache: GraphView | undefined
  /**
   * Asserted facts by subject, maintained across writes so the per-fact
   * `functional` check costs the subject's degree, not a table scan. Built
   * lazily from the table on first use.
   */
  #bySubject: Map<string, Map<string, Fact>> | undefined

  /**
   * @param domain - The opened ontology domain.
   * @param limits - Capacity and strictness policy from plugin configuration.
   */
  constructor(domain: Domain<OntologyDomainSpec>, limits: StoreLimits) {
    this.#terms = domain.table('terms')
    this.#entities = domain.table('entities')
    this.#facts = domain.table('facts')
    this.#limits = limits
  }

  /** The current graph view; one object per write generation. */
  get graph(): GraphView {
    this.#cache ??= {
      terms: new TableView(this.#terms),
      entities: new TableView(this.#entities),
      facts: new TableView(this.#facts),
      factsBySubject: subject => this.#subjectIndex().get(subject)?.values() ?? [],
    }
    return this.#cache
  }

  /** The subject index, built on first use. */
  #subjectIndex(): Map<string, Map<string, Fact>> {
    if (this.#bySubject === undefined) {
      this.#bySubject = new Map()
      for (const [key, fact] of this.#facts.entries()) this.#indexFact(key, fact)
    }
    return this.#bySubject
  }

  #indexFact(key: string, fact: Fact): void {
    if (this.#bySubject === undefined) return
    let bucket = this.#bySubject.get(fact.subject)
    if (bucket === undefined) {
      bucket = new Map()
      this.#bySubject.set(fact.subject, bucket)
    }
    bucket.set(key, fact)
  }

  #unindexFact(key: string, fact: Fact | undefined): void {
    if (this.#bySubject === undefined || fact === undefined) return
    const bucket = this.#bySubject.get(fact.subject)
    if (bucket === undefined) return
    bucket.delete(key)
    if (bucket.size === 0) this.#bySubject.delete(fact.subject)
  }

  /**
   * Define or redefine a class. A redefinition replaces the term wholesale —
   * there is no partial merge — and preserves the original `createdAt`.
   * @param input - The class definition.
   * @param now - Timestamp for the write, as ISO-8601.
   * @returns whether the write was accepted, with any violations.
   */
  async defineClass(input: ClassInput, now: string): Promise<WriteOutcome> {
    const violations = validateClassInput(this.graph, input)
    if (violations.length > 0) return { ok: false, violations }
    const previous = this.#terms.get(input.id)
    const term: Term = {
      kind: 'class',
      id: input.id,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      subClassOf: [...(input.subClassOf ?? [])],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    return this.#redefine(term)
  }

  /**
   * Define or redefine a relation.
   * @param input - The relation definition.
   * @param now - Timestamp for the write, as ISO-8601.
   * @returns whether the write was accepted, with any violations.
   */
  async defineRelation(input: RelationInput, now: string): Promise<WriteOutcome> {
    const violations = validateRelationInput(this.graph, input)
    if (violations.length > 0) return { ok: false, violations }
    const previous = this.#terms.get(input.id)
    const term: Term = {
      kind: 'relation',
      id: input.id,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      domain: [...(input.domain ?? [])],
      rangeKind: input.rangeKind ?? 'entity',
      range: [...(input.range ?? [])],
      characteristics: [...(input.characteristics ?? [])],
      ...(input.inverseOf === undefined ? {} : { inverseOf: input.inverseOf }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    return this.#redefine(term)
  }

  /**
   * Write a term, re-validating stored facts when it replaces an existing one.
   * Under `strict` an invalidating redefinition is refused; otherwise it is
   * applied and the invalidated facts are reported as violations so the
   * caller can surface them.
   * @param term - The complete new term.
   * @returns the write outcome.
   */
  async #redefine(term: Term): Promise<WriteOutcome> {
    const violations = validateRedefinition(this.graph, term)
    if (violations.length > 0 && this.#limits.strict) return { ok: false, violations }
    await this.#write(() => this.#terms.put(term.id, term))
    return violations.length === 0 ? ACCEPTED : { ok: true, violations }
  }

  /**
   * Assert an entity. An existing entity's classes are unioned rather than
   * replaced: two independent observations of the same individual should
   * accumulate, and narrowing is an explicit retract-then-assert.
   * @param input - The entity assertion.
   * @param now - Timestamp for the write, as ISO-8601.
   * @returns whether the write was accepted, with any violations.
   */
  async assertEntity(input: EntityInput, now: string): Promise<WriteOutcome> {
    const violations = validateEntityInput(this.graph, input)
    if (violations.length > 0) return { ok: false, violations }
    const previous = this.#entities.get(input.id)
    if (previous === undefined && this.#entities.size >= this.#limits.maxEntities) {
      return {
        ok: false,
        violations: [{
          code: 'capacity',
          message: `entity limit reached (maxEntities = ${this.#limits.maxEntities}); `
            + 'retract unused entities or raise the limit in the plugin configuration',
        }],
      }
    }
    const classes = [...new Set([...(previous?.classes ?? []), ...(input.classes ?? [])])]
    const label = input.label ?? previous?.label
    const comment = input.comment ?? previous?.comment
    const entity: Entity = {
      id: input.id,
      classes,
      ...(label === undefined ? {} : { label }),
      ...(comment === undefined ? {} : { comment }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    // A brand-new id that looks like an existing one is accepted but flagged:
    // the store cannot know whether `mod:api` and `api` are one thing.
    const duplicates = previous === undefined ? likelyDuplicates(this.graph, input.id, input.label) : []
    await this.#write(() => this.#entities.put(input.id, entity))
    if (duplicates.length === 0) return ACCEPTED
    return {
      ok: true,
      violations: [{
        code: 'possible-duplicate',
        message: `${input.id} looks like existing ${duplicates.join(', ')}; if they are the same individual, `
          + `merge with ontology_assert merges: [{ from: "${input.id}", into: "${duplicates[0]}" }]`,
      }],
    }
  }

  /**
   * Assert a fact. Under `strict` a TBox violation rejects the write; otherwise
   * the fact is stored with the violations recorded on it so the inconsistency
   * stays visible rather than silently accepted.
   * @param input - The fact assertion.
   * @param now - Timestamp for the write, as ISO-8601.
   * @returns whether the write was accepted, with any violations.
   */
  async assertFact(input: FactInput, now: string): Promise<WriteOutcome> {
    const violations = validateFactInput(this.graph, input)
    if (violations.length > 0 && this.#limits.strict) return { ok: false, violations }

    const key = factKey(input.subject, input.predicate, input.object)
    if (this.#facts.get(key) === undefined && this.#facts.size >= this.#limits.maxFacts) {
      return {
        ok: false,
        violations: [{
          code: 'capacity',
          message: `fact limit reached (maxFacts = ${this.#limits.maxFacts}); `
            + 'retract stale facts or raise the limit in the plugin configuration',
        }],
      }
    }
    if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
      return {
        ok: false,
        violations: [{ code: 'invalid-confidence', message: 'confidence must be within [0, 1]' }],
      }
    }

    const relation = this.graph.terms.get(input.predicate)
    const objectKind: RangeKind = relation?.kind === 'relation' ? relation.rangeKind : 'entity'
    const fact: Fact = {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      objectKind,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      violations: violations.map(violation => violation.message),
      createdAt: now,
    }
    await this.#write(async () => {
      await this.#facts.put(key, fact)
      this.#indexFact(key, fact)
    })
    return { ok: true, violations }
  }

  /**
   * Merge one entity into another: the survivor takes the union of classes,
   * fills a missing label/comment from the absorbed entity, and every fact
   * mentioning the absorbed id is rewritten to the survivor. A rewritten
   * triple that already exists is dropped rather than duplicated. Under
   * `strict`, a rewrite that would violate the TBox (typically a `functional`
   * relation that now sees two objects) refuses the whole merge.
   * @param from - Entity to absorb; removed on success.
   * @param into - Surviving entity.
   * @param now - Timestamp for the write, as ISO-8601.
   * @returns the outcome and how many facts were rewritten.
   */
  async mergeEntities(from: string, into: string, now: string): Promise<WriteOutcome & { readonly facts: number }> {
    const source = this.#entities.get(from)
    const target = this.#entities.get(into)
    const violations: Violation[] = []
    if (from === into) violations.push({ code: 'merge-self', message: `cannot merge ${from} into itself` })
    if (source === undefined) violations.push({ code: 'unknown-entity', message: `entity ${from} is not known` })
    if (target === undefined) violations.push({ code: 'unknown-entity', message: `entity ${into} is not known` })
    if (violations.length > 0 || source === undefined || target === undefined) return { ok: false, violations, facts: 0 }

    const index = factIndex(this.graph, false)
    const touched = new Map<string, Fact>()
    for (const fact of index.bySubject.get(from) ?? []) touched.set(factKey(fact.subject, fact.predicate, fact.object), fact)
    for (const fact of index.byObject.get(from) ?? []) {
      if (fact.objectKind === 'entity') touched.set(factKey(fact.subject, fact.predicate, fact.object), fact)
    }
    const rewritten = new Map<string, Fact>()
    for (const fact of touched.values()) {
      const subject = fact.subject === from ? into : fact.subject
      const object = fact.objectKind === 'entity' && fact.object === from ? into : fact.object
      const key = factKey(subject, fact.predicate, object)
      if (this.#facts.get(key) !== undefined || rewritten.has(key)) continue
      rewritten.set(key, { ...fact, subject, object })
    }
    // Validate the rewrites against the graph as it will be once the old
    // facts are gone: a functional clash only counts against facts that stay
    // or against another rewrite.
    const conflicts: Violation[] = []
    for (const [key, fact] of rewritten) {
      for (const violation of validateFactInput(this.graph, fact)) {
        if (violation.code === 'functional-conflict') {
          const stillHeld = (index.bySubject.get(fact.subject) ?? [])
            .some(other => other.predicate === fact.predicate && other.object !== fact.object
              && !touched.has(factKey(other.subject, other.predicate, other.object)))
          const amongRewrites = [...rewritten.values()]
            .some(other => other !== fact && other.subject === fact.subject && other.predicate === fact.predicate && other.object !== fact.object)
          if (!stillHeld && !amongRewrites) continue
        }
        conflicts.push({ code: violation.code, message: `${key.replaceAll(FACT_KEY_SEPARATOR, ' ')}: ${violation.message}` })
      }
    }
    if (conflicts.length > 0 && this.#limits.strict) return { ok: false, violations: conflicts, facts: 0 }

    const label = target.label ?? source.label
    const comment = target.comment ?? source.comment
    const merged: Entity = {
      id: into,
      classes: [...new Set([...target.classes, ...source.classes])],
      ...(label === undefined ? {} : { label }),
      ...(comment === undefined ? {} : { comment }),
      createdAt: target.createdAt,
      updatedAt: now,
    }
    await this.#write(async () => {
      for (const [key, fact] of touched) {
        await this.#facts.delete(key)
        this.#unindexFact(key, fact)
      }
      for (const [key, fact] of rewritten) {
        await this.#facts.put(key, fact)
        this.#indexFact(key, fact)
      }
      await this.#entities.put(into, merged)
      await this.#entities.delete(from)
    })
    return { ok: true, violations: conflicts, facts: rewritten.size }
  }

  /**
   * Retract a term. Refuses while anything still depends on it — a dangling
   * class reference would make every later domain/range check meaningless.
   * @param id - Term id.
   * @returns whether the term existed and was removed, with any violations.
   */
  async retractTerm(id: string): Promise<WriteOutcome & { readonly removed: boolean }> {
    const term = this.#terms.get(id)
    if (term === undefined) return { ok: true, violations: [], removed: false }

    const blockers: Violation[] = []
    if (term.kind === 'class') {
      for (const [, entity] of this.#entities.entries()) {
        if (entity.classes.includes(id)) {
          blockers.push({ code: 'class-in-use', message: `class ${id} still classifies entity ${entity.id}` })
          break
        }
      }
      for (const [, other] of this.#terms.entries()) {
        if (other.kind === 'class' && other.subClassOf.includes(id)) {
          blockers.push({ code: 'class-in-use', message: `class ${id} is a superclass of ${other.id}` })
          break
        }
        if (other.kind === 'relation' && (other.domain.includes(id) || other.range.includes(id))) {
          blockers.push({ code: 'class-in-use', message: `class ${id} appears in the signature of ${other.id}` })
          break
        }
      }
    } else {
      for (const [, fact] of this.#facts.entries()) {
        if (fact.predicate === id) {
          blockers.push({
            code: 'relation-in-use',
            message: `relation ${id} is still asserted (e.g. ${fact.subject} ${id} ${fact.object})`,
          })
          break
        }
      }
      for (const [, other] of this.#terms.entries()) {
        if (other.kind === 'relation' && other.inverseOf === id && other.id !== id) {
          blockers.push({ code: 'relation-in-use', message: `relation ${other.id} declares ${id} as its inverse` })
          break
        }
      }
    }
    if (blockers.length > 0) return { ok: false, violations: blockers, removed: false }

    await this.#write(() => this.#terms.delete(id))
    return { ok: true, violations: [], removed: true }
  }

  /**
   * Retract an entity and every fact mentioning it.
   * @param id - Entity id.
   * @returns whether the entity existed, and how many facts went with it.
   */
  async retractEntity(id: string): Promise<{ readonly removed: boolean, readonly facts: number }> {
    const existed = this.#entities.get(id) !== undefined
    const index = factIndex(this.graph, false)
    const doomed = new Set<string>()
    for (const fact of index.bySubject.get(id) ?? []) doomed.add(factKey(fact.subject, fact.predicate, fact.object))
    for (const fact of index.byObject.get(id) ?? []) {
      if (fact.objectKind === 'entity') doomed.add(factKey(fact.subject, fact.predicate, fact.object))
    }
    await this.#write(async () => {
      for (const key of doomed) {
        const fact = this.#facts.get(key)
        await this.#facts.delete(key)
        this.#unindexFact(key, fact)
      }
      if (existed) await this.#entities.delete(id)
    })
    return { removed: existed, facts: doomed.size }
  }

  /**
   * Retract one asserted fact. Entailed facts have no stored key and disappear
   * on their own once a premise is gone.
   * @param subject - Subject entity id.
   * @param predicate - Relation id.
   * @param object - Object entity id or literal.
   * @returns whether a stored fact was removed.
   */
  async retractFact(subject: string, predicate: string, object: string): Promise<boolean> {
    const key = factKey(subject, predicate, object)
    let removed = false
    await this.#write(async () => {
      const fact = this.#facts.get(key)
      removed = await this.#facts.delete(key)
      this.#unindexFact(key, fact)
    })
    return removed
  }

  /**
   * Run one durable mutation and start a new read generation afterwards.
   * @param mutate - The write to perform.
   */
  async #write(mutate: () => Promise<unknown>): Promise<void> {
    await mutate()
    this.#cache = undefined
  }
}
