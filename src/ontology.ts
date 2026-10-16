/**
 * The ontology's reasoning core: identifier syntax, subsumption closure, TBox
 * constraint checking, entailment under relation characteristics, and graph
 * queries. Everything here is a pure function of a {@link GraphView} — no IO,
 * no storage, no Cordis — so the rules that decide whether the agent's claim is
 * admissible are testable in isolation and reusable outside the harness.
 * @module dsh-ontology/ontology
 */

import {
  FACT_KEY_SEPARATOR,
  ID_MAX_LENGTH,
  ID_PATTERN,
} from './types.ts'
import type {
  ClassTerm,
  DerivedFact,
  Entity,
  Fact,
  GraphTable,
  GraphView,
  RangeKind,
  RelationCharacteristic,
  RelationTerm,
  Term,
  Violation,
} from './types.ts'

export * from './types.ts'

/**
 * Default bound on derived facts per graph. Reaching it stops derivation and
 * marks the result truncated rather than silently returning a partial closure.
 */
export const DEFAULT_ENTAILMENT_LIMIT = 20000

// ---------------------------------------------------------------------------
// Identifiers and keys
// ---------------------------------------------------------------------------

/**
 * Check one identifier against {@link ID_PATTERN}.
 * @param id - The candidate identifier.
 * @param what - Role of the identifier, used in the message (`class`, `entity`…).
 * @returns the violation, or `undefined` when the identifier is well-formed.
 */
export function checkId(id: string, what: string): Violation | undefined {
  if (id.length === 0) return { code: 'invalid-id', message: `${what} id must not be empty` }
  if (id.length > ID_MAX_LENGTH) {
    return {
      code: 'invalid-id',
      message: `${what} id ${JSON.stringify(id)} exceeds ${ID_MAX_LENGTH} characters`,
    }
  }
  if (!ID_PATTERN.test(id)) {
    return {
      code: 'invalid-id',
      message: `${what} id ${JSON.stringify(id)} must start with a letter or underscore and `
        + 'contain only letters, digits, and `_ . : -`',
    }
  }
  return undefined
}

/**
 * Build the durable record key of one triple. Identifier syntax excludes the
 * separator, so the join is unambiguous and needs no escaping.
 * @param subject - Subject entity id.
 * @param predicate - Relation id.
 * @param object - Object entity id or literal value.
 * @returns the composite key.
 */
export function factKey(subject: string, predicate: string, object: string): string {
  return `${subject}${FACT_KEY_SEPARATOR}${predicate}${FACT_KEY_SEPARATOR}${object}`
}

// ---------------------------------------------------------------------------
// Term lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a class term.
 * @param graph - The graph to read.
 * @param id - Class id.
 * @returns the class term, or `undefined` when absent or not a class.
 */
export function classOf(graph: GraphView, id: string): ClassTerm | undefined {
  const term = graph.terms.get(id)
  return term?.kind === 'class' ? term : undefined
}

/**
 * Resolve a relation term.
 * @param graph - The graph to read.
 * @param id - Relation id.
 * @returns the relation term, or `undefined` when absent or not a relation.
 */
export function relationOf(graph: GraphView, id: string): RelationTerm | undefined {
  const term = graph.terms.get(id)
  return term?.kind === 'relation' ? term : undefined
}

// ---------------------------------------------------------------------------
// Subsumption
// ---------------------------------------------------------------------------

/**
 * Walk the `subClassOf` graph upward from one class.
 *
 * Cycle-safe by construction (the visited set doubles as the result), so a
 * graph that somehow acquired a cycle still terminates instead of hanging the
 * agent loop. `validateClassInput` is what normally prevents such a cycle.
 * @param terms - The TBox.
 * @param classId - Starting class.
 * @returns the class itself plus every ancestor reachable from it.
 */
export function classAncestors(terms: GraphTable<Term>, classId: string): Set<string> {
  const seen = new Set<string>()
  const queue = [classId]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const term = terms.get(current)
    if (term?.kind !== 'class') continue
    for (const parent of term.subClassOf) queue.push(parent)
  }
  return seen
}

/**
 * Collect every class subsumed by one class.
 * @param terms - The TBox.
 * @param classId - The subsuming class.
 * @returns the class itself plus every descendant.
 */
export function classDescendants(terms: GraphTable<Term>, classId: string): Set<string> {
  const result = new Set<string>([classId])
  // Fixpoint over the direct-parent edges: a class joins once any parent is in.
  let grew = true
  while (grew) {
    grew = false
    for (const term of terms.values()) {
      if (term.kind !== 'class' || result.has(term.id)) continue
      if (term.subClassOf.some(parent => result.has(parent))) {
        result.add(term.id)
        grew = true
      }
    }
  }
  return result
}

/**
 * The effective class membership of one entity: its declared classes closed
 * under `subClassOf`.
 * @param graph - The graph to read.
 * @param entityId - Entity to resolve.
 * @returns every class the entity belongs to, directly or by subsumption.
 */
export function entityClasses(graph: GraphView, entityId: string): Set<string> {
  const entity = graph.entities.get(entityId)
  if (entity === undefined) return new Set()
  return classesOf(graph, entity)
}

/**
 * Effective classes of an entity record, with the per-class ancestor walk
 * memoized per graph view so a scan over every entity costs one walk per
 * distinct class rather than one per entity.
 * @param graph - The graph to read.
 * @param entity - The entity record.
 * @returns every class the entity belongs to, directly or by subsumption.
 */
function classesOf(graph: GraphView, entity: Entity): Set<string> {
  let ancestors = ancestorCache.get(graph)
  if (ancestors === undefined) {
    ancestors = new Map()
    ancestorCache.set(graph, ancestors)
  }
  const result = new Set<string>()
  for (const direct of entity.classes) {
    let walked = ancestors.get(direct)
    if (walked === undefined) {
      walked = classAncestors(graph.terms, direct)
      ancestors.set(direct, walked)
    }
    for (const ancestor of walked) result.add(ancestor)
  }
  return result
}

const ancestorCache = new WeakMap<GraphView, Map<string, Set<string>>>()

// ---------------------------------------------------------------------------
// TBox validation
// ---------------------------------------------------------------------------

/** Author-supplied class definition, before defaults and timestamps. */
export interface ClassInput {
  readonly id: string
  readonly label?: string
  readonly comment?: string
  readonly subClassOf?: readonly string[]
}

/** Author-supplied relation definition, before defaults and timestamps. */
export interface RelationInput {
  readonly id: string
  readonly label?: string
  readonly comment?: string
  readonly domain?: readonly string[]
  readonly rangeKind?: RangeKind
  readonly range?: readonly string[]
  readonly characteristics?: readonly RelationCharacteristic[]
  readonly inverseOf?: string
}

/**
 * Check a class definition against the current TBox.
 *
 * Rejects an id that collides with an existing relation, unknown superclasses,
 * and any `subClassOf` edge that would close a subsumption cycle — a cycle
 * would make "is an X" unfalsifiable for every class on it.
 * @param graph - The graph the definition would be applied to.
 * @param input - The candidate class.
 * @returns every violation found; empty means admissible.
 */
export function validateClassInput(graph: GraphView, input: ClassInput): Violation[] {
  const violations: Violation[] = []
  const idViolation = checkId(input.id, 'class')
  if (idViolation !== undefined) violations.push(idViolation)

  const existing = graph.terms.get(input.id)
  if (existing !== undefined && existing.kind !== 'class') {
    violations.push({
      code: 'kind-conflict',
      message: `${input.id} is already defined as a relation; retract it before redefining it as a class`,
    })
  }

  for (const parent of input.subClassOf ?? []) {
    const parentTerm = graph.terms.get(parent)
    if (parentTerm === undefined) {
      violations.push({
        code: 'unknown-class',
        message: `superclass ${parent} of ${input.id} is not defined`,
      })
      continue
    }
    if (parentTerm.kind !== 'class') {
      violations.push({
        code: 'kind-conflict',
        message: `superclass ${parent} of ${input.id} is a relation, not a class`,
      })
      continue
    }
    // The edge closes a cycle when the new class already subsumes its parent.
    if (parent === input.id || classAncestors(graph.terms, parent).has(input.id)) {
      violations.push({
        code: 'subclass-cycle',
        message: `${input.id} subClassOf ${parent} would create a subsumption cycle`,
      })
    }
  }
  return violations
}

/**
 * Check a relation definition against the current TBox.
 *
 * Beyond id and reference checks, this enforces the two coherence rules that
 * make entailment sound: a literal-valued relation can be neither inverse nor
 * symmetric nor transitive (its objects are not entities, so the derived
 * triples would have a literal in subject position), and a declared inverse
 * must itself be an entity-valued relation.
 * @param graph - The graph the definition would be applied to.
 * @param input - The candidate relation.
 * @returns every violation found; empty means admissible.
 */
export function validateRelationInput(graph: GraphView, input: RelationInput): Violation[] {
  const violations: Violation[] = []
  const idViolation = checkId(input.id, 'relation')
  if (idViolation !== undefined) violations.push(idViolation)

  const existing = graph.terms.get(input.id)
  if (existing !== undefined && existing.kind !== 'relation') {
    violations.push({
      code: 'kind-conflict',
      message: `${input.id} is already defined as a class; retract it before redefining it as a relation`,
    })
  }

  const rangeKind: RangeKind = input.rangeKind ?? 'entity'
  for (const [role, ids] of [['domain', input.domain ?? []], ['range', input.range ?? []]] as const) {
    if (role === 'range' && rangeKind === 'literal' && ids.length > 0) {
      violations.push({
        code: 'literal-range',
        message: `${input.id} has rangeKind "literal", so it cannot also constrain range classes`,
      })
      continue
    }
    for (const id of ids) {
      if (classOf(graph, id) === undefined) {
        violations.push({
          code: 'unknown-class',
          message: `${role} class ${id} of relation ${input.id} is not defined`,
        })
      }
    }
  }

  const characteristics = input.characteristics ?? []
  if (rangeKind === 'literal') {
    for (const characteristic of characteristics) {
      if (characteristic === 'symmetric' || characteristic === 'transitive') {
        violations.push({
          code: 'literal-characteristic',
          message: `${input.id} is literal-valued, so it cannot be ${characteristic} `
            + '(the entailed triple would have a literal as its subject)',
        })
      }
    }
    if (input.inverseOf !== undefined) {
      violations.push({
        code: 'literal-inverse',
        message: `${input.id} is literal-valued, so it cannot declare an inverse`,
      })
    }
  }

  if (input.inverseOf !== undefined && rangeKind === 'entity') {
    const inverse = graph.terms.get(input.inverseOf)
    if (inverse === undefined) {
      // Self-inverse is the one forward reference worth allowing, since a pair
      // must otherwise be defined in one call to reference each other.
      if (input.inverseOf !== input.id) {
        violations.push({
          code: 'unknown-relation',
          message: `inverse ${input.inverseOf} of ${input.id} is not defined; define it first`,
        })
      }
    } else if (inverse.kind !== 'relation') {
      violations.push({
        code: 'kind-conflict',
        message: `inverse ${input.inverseOf} of ${input.id} is a class, not a relation`,
      })
    } else if (inverse.rangeKind === 'literal') {
      violations.push({
        code: 'literal-inverse',
        message: `inverse ${input.inverseOf} of ${input.id} is literal-valued and cannot be inverted`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Near-duplicate entities
// ---------------------------------------------------------------------------

/**
 * Reduce an identifier or label to the form two spellings of one thing share:
 * lower-cased, a `ns:` namespace prefix stripped, and separators collapsed.
 * @param text - Identifier or label.
 * @returns the comparison key.
 */
function duplicateKey(text: string): string {
  // Only `:` is treated as a namespace separator; a dot is ambiguous with a
  // file extension (`tools.ts`), so dotted ids compare whole.
  const stripped = text.slice(text.lastIndexOf(':') + 1)
  return stripped.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * Find existing entities that a new entity id probably duplicates: same id up
 * to case, separators, or a namespace prefix, or a label equal to the new id
 * (or vice versa). The agent coins these constantly (`mod:tools.ts` beside
 * `tools.ts`); the check cannot be certain, so callers surface it as a
 * warning that names `merges` as the remedy rather than refusing the write.
 * @param graph - The graph to read.
 * @param id - The new entity id (not yet present).
 * @param label - Its label, when given.
 * @returns ids of likely duplicates, in iteration order.
 */
export function likelyDuplicates(graph: GraphView, id: string, label?: string): string[] {
  const keys = new Set([duplicateKey(id), ...(label === undefined ? [] : [duplicateKey(label)])])
  const found: string[] = []
  for (const entity of graph.entities.values()) {
    if (entity.id === id) continue
    if (keys.has(duplicateKey(entity.id)) || (entity.label !== undefined && keys.has(duplicateKey(entity.label)))) {
      found.push(entity.id)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Redefinition
// ---------------------------------------------------------------------------

/** A {@link GraphTable} that answers one key from an override, the rest from a base table. */
class OverlayTable<V> implements GraphTable<V> {
  readonly #base: GraphTable<V>
  readonly #key: string
  readonly #value: V

  constructor(base: GraphTable<V>, key: string, value: V) {
    this.#base = base
    this.#key = key
    this.#value = value
  }

  get size(): number {
    return this.#base.has(this.#key) ? this.#base.size : this.#base.size + 1
  }

  get(key: string): V | undefined {
    return key === this.#key ? this.#value : this.#base.get(key)
  }

  has(key: string): boolean {
    return key === this.#key || this.#base.has(key)
  }

  * keys(): Iterable<string> {
    yield* this.entriesWith(([key]) => key)
  }

  * values(): Iterable<V> {
    yield* this.entriesWith(([, value]) => value)
  }

  * entries(): Iterable<[string, V]> {
    yield* this.entriesWith(entry => entry)
  }

  private * entriesWith<T>(project: (entry: [string, V]) => T): Iterable<T> {
    let seen = false
    for (const [key, value] of this.#base.entries()) {
      if (key === this.#key) {
        seen = true
        yield project([key, this.#value])
      } else {
        yield project([key, value])
      }
    }
    if (!seen) yield project([this.#key, this.#value])
  }
}

/** Upper bound on example facts quoted in a redefinition violation. */
const REDEFINITION_EXAMPLES = 3

/**
 * Check what an already-populated graph would look like under a replacement
 * definition of one term.
 *
 * Redefinition replaces a term wholesale, so narrowing a relation's domain,
 * flipping its `rangeKind`, making it `functional`, or cutting a class out of
 * a `subClassOf` chain can silently turn stored facts into violations of the
 * very vocabulary that is supposed to govern them. This re-validates the
 * affected facts against the would-be TBox — every fact of the relation, or
 * every fact at all when a class changes (membership closure can shift any
 * domain or range check) — and reports the ones that would no longer hold.
 * @param graph - The current graph.
 * @param term - The replacement definition.
 * @returns one violation per invalidated fact, capped in message detail but
 * not in count, as `redefinition-invalidates`; empty when the data still fits.
 */
export function validateRedefinition(graph: GraphView, term: Term): Violation[] {
  if (!graph.terms.has(term.id)) return []
  const overlay: GraphView = {
    terms: new OverlayTable(graph.terms, term.id, term),
    entities: graph.entities,
    facts: graph.facts,
  }
  const affected: Iterable<Fact> = term.kind === 'relation'
    ? factIndex(graph, false).byPredicate.get(term.id) ?? []
    : graph.facts.values()

  const broken: { fact: Fact, reasons: string[] }[] = []
  for (const fact of affected) {
    const reasons = validateFactInput(overlay, fact)
      // A fact already stored with recorded violations (non-strict) is not
      // newly broken by the redefinition when the same reasons were present.
      .filter(violation => !fact.violations.includes(violation.message))
    if (reasons.length > 0) broken.push({ fact, reasons: reasons.map(violation => violation.message) })
  }
  if (broken.length === 0) return []

  const examples = broken.slice(0, REDEFINITION_EXAMPLES)
    .map(({ fact, reasons }) => `${fact.subject} ${fact.predicate} ${fact.object}: ${reasons.join('; ')}`)
  const more = broken.length > examples.length ? `; and ${broken.length - examples.length} more` : ''
  return [{
    code: 'redefinition-invalidates',
    message: `redefining ${term.kind} ${term.id} would invalidate ${broken.length} asserted fact(s) — `
      + `${examples.join(' | ')}${more}. Retract or correct them first, or redefine under strict: false `
      + 'to keep them with the violations recorded',
  }]
}

// ---------------------------------------------------------------------------
// ABox validation
// ---------------------------------------------------------------------------

/** Author-supplied entity assertion. */
export interface EntityInput {
  readonly id: string
  readonly classes?: readonly string[]
  readonly label?: string
  readonly comment?: string
}

/** Author-supplied fact assertion. */
export interface FactInput {
  readonly subject: string
  readonly predicate: string
  readonly object: string
  readonly source?: string
  readonly confidence?: number
}

/**
 * Check an entity assertion: identifier syntax and that every declared class
 * exists as a class.
 * @param graph - The graph the assertion would be applied to.
 * @param input - The candidate entity.
 * @returns every violation found; empty means admissible.
 */
export function validateEntityInput(graph: GraphView, input: EntityInput): Violation[] {
  const violations: Violation[] = []
  const idViolation = checkId(input.id, 'entity')
  if (idViolation !== undefined) violations.push(idViolation)
  for (const classId of input.classes ?? []) {
    if (classOf(graph, classId) === undefined) {
      violations.push({
        code: 'unknown-class',
        message: `class ${classId} of entity ${input.id} is not defined`,
      })
    }
  }
  return violations
}

/**
 * Check a fact against the TBox — the constraint that distinguishes this
 * plugin from free-text memory.
 *
 * Checked in order: the predicate is a defined relation; the subject is a known
 * entity within the relation's domain; the object matches the relation's
 * `rangeKind` and, for entity objects, is known and within its range; and a
 * `functional` relation does not already hold with a different object.
 * @param graph - The graph the assertion would be applied to.
 * @param input - The candidate fact.
 * @returns every violation found; empty means admissible.
 */
export function validateFactInput(graph: GraphView, input: FactInput): Violation[] {
  const violations: Violation[] = []

  const subjectIdViolation = checkId(input.subject, 'subject')
  if (subjectIdViolation !== undefined) violations.push(subjectIdViolation)

  const relation = relationOf(graph, input.predicate)
  if (relation === undefined) {
    violations.push({
      code: 'unknown-relation',
      message: `predicate ${input.predicate} is not a defined relation; declare it with ontology_define first`,
    })
    // Every remaining rule reads the relation, so stop here.
    return violations
  }

  if (!graph.entities.has(input.subject)) {
    violations.push({
      code: 'unknown-entity',
      message: `subject ${input.subject} is not a known entity; assert it before using it`,
    })
  } else if (relation.domain.length > 0) {
    const subjectClasses = entityClasses(graph, input.subject)
    if (!relation.domain.some(allowed => subjectClasses.has(allowed))) {
      violations.push({
        code: 'domain-mismatch',
        message: `${input.subject} is not in the domain of ${relation.id} `
          + `(requires one of: ${relation.domain.join(', ')}; has: ${describeClasses(subjectClasses)})`,
      })
    }
  }

  if (relation.rangeKind === 'literal') {
    if (input.object.length === 0) {
      violations.push({
        code: 'empty-literal',
        message: `${relation.id} expects a literal value, but the object is empty`,
      })
    }
  } else if (!graph.entities.has(input.object)) {
    violations.push({
      code: 'unknown-entity',
      message: `object ${input.object} is not a known entity; assert it before using it `
        + `(${relation.id} is entity-valued)`,
    })
  } else if (relation.range.length > 0) {
    const objectClasses = entityClasses(graph, input.object)
    if (!relation.range.some(allowed => objectClasses.has(allowed))) {
      violations.push({
        code: 'range-mismatch',
        message: `${input.object} is not in the range of ${relation.id} `
          + `(requires one of: ${relation.range.join(', ')}; has: ${describeClasses(objectClasses)})`,
      })
    }
  }

  if (relation.characteristics.includes('functional')) {
    const candidates = graph.factsBySubject?.(input.subject) ?? factIndex(graph, false).bySubject.get(input.subject) ?? []
    for (const fact of candidates) {
      if (fact.predicate === relation.id && fact.object !== input.object) {
        violations.push({
          code: 'functional-conflict',
          message: `${relation.id} is functional and ${input.subject} already has `
            + `${relation.id} = ${fact.object}; retract that fact first`,
        })
        break
      }
    }
  }
  return violations
}

/**
 * Render a class set for an error message.
 * @param classes - Effective class membership.
 * @returns a comma-joined list, or `none` when the set is empty.
 */
function describeClasses(classes: ReadonlySet<string>): string {
  return classes.size === 0 ? 'none' : [...classes].sort().join(', ')
}

// ---------------------------------------------------------------------------
// Entailment
// ---------------------------------------------------------------------------

/** The derived facts of one graph, and whether the derivation ran to its fixpoint. */
export interface Entailment {
  readonly facts: readonly DerivedFact[]
  /**
   * `true` when the limit stopped derivation early. The facts are then a
   * prefix of the closure, not the closure, and any consumer that reports
   * inferred results should say so.
   */
  readonly truncated: boolean
}

const entailmentCache = new WeakMap<GraphView, Map<number, Entailment>>()

/**
 * Derive the facts that follow from the asserted ones under the relations'
 * declared characteristics.
 *
 * A worklist (semi-naive) fixpoint: every fact, asserted or derived, is
 * processed exactly once, and a transitive step joins it against an adjacency
 * index of everything known so far in both directions, so the cost is
 * proportional to the closure and the degrees involved rather than to the
 * square of the fact count per round. Rules compose: an inverse of a
 * transitive relation is itself closed transitively.
 *
 * Derived facts are never persisted — retracting a premise removes everything
 * that rested on it. The result is memoized per graph view and limit, so one
 * write generation pays for derivation once however many queries read it.
 * @param graph - The graph to reason over.
 * @param limit - Maximum number of derived facts; reaching it stops derivation.
 * @returns the entailed facts, tagged with the rule that produced each, and the truncation flag.
 */
export function entailment(graph: GraphView, limit = DEFAULT_ENTAILMENT_LIMIT): Entailment {
  let perLimit = entailmentCache.get(graph)
  if (perLimit === undefined) {
    perLimit = new Map()
    entailmentCache.set(graph, perLimit)
  }
  const cached = perLimit.get(limit)
  if (cached !== undefined) return cached
  const result = computeEntailment(graph, limit)
  perLimit.set(limit, result)
  return result
}

/**
 * Derive the facts that follow from the asserted ones. See {@link entailment},
 * which this wraps for callers that only need the facts.
 * @param graph - The graph to reason over.
 * @param limit - Maximum number of derived facts; reaching it stops derivation.
 * @returns the entailed facts, each tagged with the rule that produced it.
 */
export function entail(graph: GraphView, limit = DEFAULT_ENTAILMENT_LIMIT): DerivedFact[] {
  return [...entailment(graph, limit).facts]
}

/**
 * The uncached worklist fixpoint behind {@link entailment}.
 * @param graph - The graph to reason over.
 * @param limit - Maximum number of derived facts.
 * @returns the entailment.
 */
function computeEntailment(graph: GraphView, limit: number): Entailment {
  /** Keys of every fact known so far, asserted or derived. */
  const known = new Set<string>(graph.facts.keys())
  const derived: DerivedFact[] = []
  /** predicate -> subject -> objects, over entity-valued facts known so far. */
  const outgoing = new Map<string, Map<string, string[]>>()
  /** predicate -> object -> subjects, over entity-valued facts known so far. */
  const incoming = new Map<string, Map<string, string[]>>()
  const queue: Fact[] = []
  let truncated = false

  const link = (table: Map<string, Map<string, string[]>>, predicate: string, from: string, to: string): void => {
    let byNode = table.get(predicate)
    if (byNode === undefined) {
      byNode = new Map()
      table.set(predicate, byNode)
    }
    const list = byNode.get(from)
    if (list === undefined) byNode.set(from, [to])
    else list.push(to)
  }
  const admit = (fact: Fact): void => {
    link(outgoing, fact.predicate, fact.subject, fact.object)
    link(incoming, fact.predicate, fact.object, fact.subject)
    queue.push(fact)
  }

  for (const fact of graph.facts.values()) {
    if (relationOf(graph, fact.predicate)?.rangeKind === 'entity') admit(fact)
  }

  const add = (fact: Fact, via: DerivedFact['via']): void => {
    const key = factKey(fact.subject, fact.predicate, fact.object)
    if (known.has(key)) return
    if (derived.length >= limit) {
      truncated = true
      return
    }
    known.add(key)
    const result: DerivedFact = { ...fact, via }
    derived.push(result)
    admit(result)
  }

  for (let head = 0; head < queue.length && !truncated; head += 1) {
    const fact = queue[head]!
    const relation = relationOf(graph, fact.predicate)
    if (relation === undefined) continue

    if (relation.inverseOf !== undefined && relation.inverseOf !== relation.id) {
      add({ ...fact, subject: fact.object, predicate: relation.inverseOf, object: fact.subject }, 'inverse')
    }
    if (relation.characteristics.includes('symmetric')) {
      add({ ...fact, subject: fact.object, object: fact.subject }, 'symmetric')
    }
    if (relation.characteristics.includes('transitive')) {
      // (s p o) + (o p x) ⇒ (s p x); (x p s) + (s p o) ⇒ (x p o). Copy the
      // neighbour lists first: `add` appends to them while we iterate.
      for (const next of [...(outgoing.get(relation.id)?.get(fact.object) ?? [])]) {
        if (next === fact.subject) continue // no self-loop from a round trip
        add({ ...fact, object: next }, 'transitive')
      }
      for (const previous of [...(incoming.get(relation.id)?.get(fact.subject) ?? [])]) {
        if (previous === fact.object) continue
        add({ ...fact, subject: previous }, 'transitive')
      }
    }
  }
  return { facts: derived, truncated }
}

/**
 * The asserted facts plus, optionally, the entailed ones.
 * @param graph - The graph to read.
 * @param includeInferred - Whether to append entailments.
 * @returns every fact in scope, asserted first.
 */
export function allFacts(graph: GraphView, includeInferred: boolean): DerivedFact[] {
  return [...factIndex(graph, includeInferred).facts]
}

// ---------------------------------------------------------------------------
// Fact index
// ---------------------------------------------------------------------------

/**
 * The facts in scope for one read, indexed by each triple position. Built once
 * per graph view and inference setting, then shared by every query against
 * that generation.
 */
export interface FactIndex {
  /** Every fact in scope, asserted before entailed. */
  readonly facts: readonly DerivedFact[]
  readonly bySubject: ReadonlyMap<string, readonly DerivedFact[]>
  readonly byPredicate: ReadonlyMap<string, readonly DerivedFact[]>
  /** Keyed by the object string, whether entity id or literal value. */
  readonly byObject: ReadonlyMap<string, readonly DerivedFact[]>
  /** Whether entailment was cut short; always `false` without inference. */
  readonly truncated: boolean
}

const indexCache = new WeakMap<GraphView, Map<number, FactIndex>>()

/**
 * Index the facts in scope. Memoized per graph view and inference limit.
 * @param graph - The graph to read.
 * @param includeInferred - Whether entailed facts are in scope.
 * @param inferenceLimit - Derivation cap passed to {@link entailment}.
 * @returns the index.
 */
export function factIndex(graph: GraphView, includeInferred: boolean, inferenceLimit = DEFAULT_ENTAILMENT_LIMIT): FactIndex {
  let slot = indexCache.get(graph)
  if (slot === undefined) {
    slot = new Map()
    indexCache.set(graph, slot)
  }
  // Asserted-only indexes are the same whatever the limit; key them on -1.
  const cacheKey = includeInferred ? inferenceLimit : -1
  const cached = slot.get(cacheKey)
  if (cached !== undefined) return cached

  const asserted: DerivedFact[] = []
  for (const fact of graph.facts.values()) asserted.push({ ...fact, via: 'asserted' })
  const derivation = includeInferred ? entailment(graph, inferenceLimit) : undefined
  const facts = derivation === undefined ? asserted : [...asserted, ...derivation.facts]

  const bySubject = new Map<string, DerivedFact[]>()
  const byPredicate = new Map<string, DerivedFact[]>()
  const byObject = new Map<string, DerivedFact[]>()
  const push = (table: Map<string, DerivedFact[]>, key: string, fact: DerivedFact): void => {
    const list = table.get(key)
    if (list === undefined) table.set(key, [fact])
    else list.push(fact)
  }
  for (const fact of facts) {
    push(bySubject, fact.subject, fact)
    push(byPredicate, fact.predicate, fact)
    push(byObject, fact.object, fact)
  }
  const index: FactIndex = { facts, bySubject, byPredicate, byObject, truncated: derivation?.truncated ?? false }
  slot.set(cacheKey, index)
  return index
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Filter for {@link queryEntities}. */
export interface EntityQuery {
  /** Restrict to members of this class, including every subclass. */
  readonly classId?: string
  /** Case-insensitive substring match over id, label, and comment. */
  readonly search?: string
  readonly limit?: number
}

/**
 * Find entities by class membership and/or free-text match.
 *
 * Class matching is closed under subsumption in both directions: asking for
 * `Service` returns entities declared as its subclass `HttpService`, and an
 * entity declared directly as `Service` matches too.
 * @param graph - The graph to read.
 * @param query - The filter.
 * @returns matching entities, ordered by id.
 */
export function queryEntities(graph: GraphView, query: EntityQuery): Entity[] {
  const wanted = query.classId === undefined ? undefined : classDescendants(graph.terms, query.classId)
  const needle = query.search?.toLowerCase()
  const matches: Entity[] = []
  for (const entity of graph.entities.values()) {
    if (wanted !== undefined) {
      // Direct membership is the common case; walk ancestors only when needed.
      const direct = entity.classes.some(id => wanted.has(id))
      if (!direct && ![...classesOf(graph, entity)].some(id => wanted.has(id))) continue
    }
    if (needle !== undefined) {
      const haystack = `${entity.id}\n${entity.label ?? ''}\n${entity.comment ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    matches.push(entity)
  }
  matches.sort((left, right) => left.id.localeCompare(right.id))
  return query.limit === undefined ? matches : matches.slice(0, query.limit)
}

/** Filter for {@link queryFacts}; omitted positions are wildcards. */
export interface FactQuery {
  readonly subject?: string
  readonly predicate?: string
  readonly object?: string
  readonly includeInferred?: boolean
  /** Derivation cap when `includeInferred`; defaults to {@link DEFAULT_ENTAILMENT_LIMIT}. */
  readonly inferenceLimit?: number
  readonly limit?: number
}

/**
 * Find facts by triple pattern, scanning only the index bucket of the most
 * selective bound position.
 * @param graph - The graph to read.
 * @param query - The pattern; each omitted position matches anything.
 * @returns matching facts, asserted before entailed.
 */
export function queryFacts(graph: GraphView, query: FactQuery): DerivedFact[] {
  const index = factIndex(graph, query.includeInferred ?? false, query.inferenceLimit)
  const candidates = query.subject !== undefined
    ? index.bySubject.get(query.subject) ?? []
    : query.object !== undefined
      ? index.byObject.get(query.object) ?? []
      : query.predicate !== undefined
        ? index.byPredicate.get(query.predicate) ?? []
        : index.facts
  const matches: DerivedFact[] = []
  for (const fact of candidates) {
    if (query.subject !== undefined && fact.subject !== query.subject) continue
    if (query.predicate !== undefined && fact.predicate !== query.predicate) continue
    if (query.object !== undefined && fact.object !== query.object) continue
    matches.push(fact)
    if (query.limit !== undefined && matches.length >= query.limit) break
  }
  return matches
}

/**
 * Collect the neighbourhood of one entity out to a bounded radius, following
 * entity-valued edges in both directions.
 * @param graph - The graph to read.
 * @param entityId - The centre.
 * @param depth - Radius in edges; values below 1 are treated as 1.
 * @param includeInferred - Whether entailed edges participate.
 * @param inferenceLimit - Derivation cap when `includeInferred`.
 * @returns the reached entity ids and the facts that reached them.
 */
export function neighbors(
  graph: GraphView,
  entityId: string,
  depth: number,
  includeInferred: boolean,
  inferenceLimit = DEFAULT_ENTAILMENT_LIMIT,
): { readonly reached: string[], readonly facts: DerivedFact[] } {
  const index = factIndex(graph, includeInferred, inferenceLimit)
  const reached = new Set<string>([entityId])
  const collected = new Map<string, DerivedFact>()
  let frontier = new Set<string>([entityId])

  for (let step = 0; step < Math.max(1, depth); step += 1) {
    const next = new Set<string>()
    for (const node of frontier) {
      for (const fact of index.bySubject.get(node) ?? []) {
        collected.set(factKey(fact.subject, fact.predicate, fact.object), fact)
        if (fact.objectKind === 'entity' && !reached.has(fact.object)) next.add(fact.object)
      }
      for (const fact of index.byObject.get(node) ?? []) {
        if (fact.objectKind !== 'entity') continue
        collected.set(factKey(fact.subject, fact.predicate, fact.object), fact)
        if (!reached.has(fact.subject)) next.add(fact.subject)
      }
    }
    if (next.size === 0) break
    for (const id of next) reached.add(id)
    frontier = next
  }
  return { reached: [...reached], facts: [...collected.values()] }
}

/**
 * Shortest chain of entity-valued edges connecting two entities, treating edges
 * as undirected so a path is found regardless of assertion direction.
 * @param graph - The graph to read.
 * @param from - Start entity.
 * @param to - Target entity.
 * @param maxDepth - Maximum path length in edges.
 * @param includeInferred - Whether entailed edges participate.
 * @param inferenceLimit - Derivation cap when `includeInferred`.
 * @returns the edges of one shortest path, or `undefined` when unreachable.
 */
export function findPath(
  graph: GraphView,
  from: string,
  to: string,
  maxDepth: number,
  includeInferred: boolean,
  inferenceLimit = DEFAULT_ENTAILMENT_LIMIT,
): DerivedFact[] | undefined {
  if (from === to) return []
  const index = factIndex(graph, includeInferred, inferenceLimit)
  /** Predecessor edge of each visited node, for path reconstruction. */
  const cameFrom = new Map<string, { readonly via: DerivedFact, readonly from: string }>()
  const visited = new Set<string>([from])
  let frontier = [from]

  const reconstruct = (end: string): DerivedFact[] => {
    const path: DerivedFact[] = []
    let node = end
    while (node !== from) {
      const step = cameFrom.get(node)!
      path.push(step.via)
      node = step.from
    }
    return path.reverse()
  }

  for (let step = 0; step < Math.max(1, maxDepth); step += 1) {
    const next: string[] = []
    for (const node of frontier) {
      const edges = [
        ...(index.bySubject.get(node) ?? []).filter(fact => fact.objectKind === 'entity'),
        ...(index.byObject.get(node) ?? []).filter(fact => fact.objectKind === 'entity'),
      ]
      for (const fact of edges) {
        const other = fact.subject === node ? fact.object : fact.subject
        if (visited.has(other)) continue
        visited.add(other)
        cameFrom.set(other, { via: fact, from: node })
        if (other === to) return reconstruct(other)
        next.push(other)
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Counts describing the current graph. */
export interface GraphStats {
  readonly classes: number
  readonly relations: number
  readonly entities: number
  readonly facts: number
}

/**
 * Count the graph's contents.
 * @param graph - The graph to read.
 * @returns the term, entity, and fact counts.
 */
export function statsOf(graph: GraphView): GraphStats {
  let classes = 0
  let relations = 0
  for (const term of graph.terms.values()) {
    if (term.kind === 'class') classes += 1
    else relations += 1
  }
  return { classes, relations, entities: graph.entities.size, facts: graph.facts.size }
}

/**
 * Render the TBox as compact lines for the system prompt or a schema query.
 *
 * The model needs the vocabulary — what it may assert and against what — not
 * the instance data, which it should query on demand. Ordering is stable
 * (classes then relations, each by id) so an unchanged graph produces an
 * unchanged prompt and stays cache-friendly.
 * @param graph - The graph to read.
 * @param maxTerms - Upper bound on rendered terms; the remainder is summarized.
 * @returns one line per term, plus an elision note when terms were dropped.
 */
export function renderTBox(graph: GraphView, maxTerms: number): string[] {
  const terms = [...graph.terms.values()].sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === 'class' ? -1 : 1)
  const lines: string[] = []
  const shown = terms.slice(0, Math.max(0, maxTerms))

  for (const term of shown) {
    if (term.kind === 'class') {
      const parents = term.subClassOf.length > 0 ? ` < ${term.subClassOf.join(', ')}` : ''
      lines.push(`class ${term.id}${parents}${describeGloss(term.label, term.comment)}`)
    } else {
      const domain = term.domain.length > 0 ? term.domain.join('|') : '*'
      const range = term.rangeKind === 'literal'
        ? 'literal'
        : term.range.length > 0 ? term.range.join('|') : '*'
      const traits = [
        ...term.characteristics,
        ...(term.inverseOf === undefined ? [] : [`inverseOf ${term.inverseOf}`]),
      ]
      const suffix = traits.length > 0 ? ` [${traits.join(', ')}]` : ''
      lines.push(`rel ${term.id}: ${domain} -> ${range}${suffix}${describeGloss(term.label, term.comment)}`)
    }
  }
  if (terms.length > shown.length) {
    lines.push(`… ${terms.length - shown.length} more terms (use ontology_query mode="schema")`)
  }
  return lines
}

/**
 * Format a term's human gloss for one rendered line.
 * @param label - Optional display name.
 * @param comment - Optional definition.
 * @returns the trailing gloss, or an empty string when neither is present.
 */
function describeGloss(label: string | undefined, comment: string | undefined): string {
  const gloss = comment ?? label
  return gloss === undefined ? '' : `  — ${gloss.replace(/\s+/g, ' ').slice(0, 120)}`
}
