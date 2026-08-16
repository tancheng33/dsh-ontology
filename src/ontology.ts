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
  GraphView,
  RangeKind,
  RelationCharacteristic,
  RelationTerm,
  Term,
  Violation,
} from './types.ts'

export * from './types.ts'

/** Bound on entailment fixpoint rounds; a cyclic graph would otherwise iterate forever. */
const MAX_ENTAILMENT_ROUNDS = 32

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
export function classAncestors(terms: ReadonlyMap<string, Term>, classId: string): Set<string> {
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
export function classDescendants(terms: ReadonlyMap<string, Term>, classId: string): Set<string> {
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
  const result = new Set<string>()
  for (const direct of entity.classes) {
    for (const ancestor of classAncestors(graph.terms, direct)) result.add(ancestor)
  }
  return result
}

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
    for (const fact of graph.facts.values()) {
      if (fact.subject === input.subject && fact.predicate === relation.id && fact.object !== input.object) {
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

/**
 * Derive the facts that follow from the asserted ones under the relations'
 * declared characteristics.
 *
 * Runs to a fixpoint (bounded by {@link MAX_ENTAILMENT_ROUNDS}) so rules
 * compose: an inverse of a transitive relation is itself closed transitively.
 * Derived facts are never persisted — retracting a premise removes everything
 * that rested on it, which is the whole point of deriving on read.
 * @param graph - The graph to reason over.
 * @param limit - Maximum number of derived facts; reaching it stops derivation.
 * @returns the entailed facts, each tagged with the rule that produced it.
 */
export function entail(graph: GraphView, limit = 20000): DerivedFact[] {
  const derived = new Map<string, DerivedFact>()
  /** Keys already present as asserted facts, which never get re-derived. */
  const asserted = new Set(graph.facts.keys())

  const add = (fact: Fact, via: DerivedFact['via']): boolean => {
    const key = factKey(fact.subject, fact.predicate, fact.object)
    if (asserted.has(key) || derived.has(key)) return false
    if (derived.size >= limit) return false
    derived.set(key, { ...fact, via })
    return true
  }

  for (let round = 0; round < MAX_ENTAILMENT_ROUNDS; round += 1) {
    let grew = false
    const current: Fact[] = [...graph.facts.values(), ...derived.values()]

    for (const fact of current) {
      const relation = relationOf(graph, fact.predicate)
      if (relation === undefined || relation.rangeKind !== 'entity') continue

      if (relation.inverseOf !== undefined && relation.inverseOf !== relation.id) {
        grew = add({ ...fact, subject: fact.object, predicate: relation.inverseOf, object: fact.subject }, 'inverse') || grew
      }
      if (relation.characteristics.includes('symmetric')) {
        grew = add({ ...fact, subject: fact.object, object: fact.subject }, 'symmetric') || grew
      }
      if (relation.characteristics.includes('transitive')) {
        for (const next of current) {
          if (next.predicate !== fact.predicate || next.subject !== fact.object) continue
          if (next.object === fact.subject) continue // no self-loop from a round trip
          grew = add({ ...fact, object: next.object }, 'transitive') || grew
        }
      }
    }
    if (!grew) break
  }
  return [...derived.values()]
}

/**
 * The asserted facts plus, optionally, the entailed ones.
 * @param graph - The graph to read.
 * @param includeInferred - Whether to append entailments.
 * @returns every fact in scope, asserted first.
 */
export function allFacts(graph: GraphView, includeInferred: boolean): DerivedFact[] {
  const base: DerivedFact[] = [...graph.facts.values()].map(fact => ({ ...fact, via: 'asserted' as const }))
  return includeInferred ? [...base, ...entail(graph)] : base
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
    if (wanted !== undefined && ![...entityClasses(graph, entity.id)].some(id => wanted.has(id))) continue
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
  readonly limit?: number
}

/**
 * Find facts by triple pattern.
 * @param graph - The graph to read.
 * @param query - The pattern; each omitted position matches anything.
 * @returns matching facts, asserted before entailed.
 */
export function queryFacts(graph: GraphView, query: FactQuery): DerivedFact[] {
  const matches = allFacts(graph, query.includeInferred ?? false).filter(fact =>
    (query.subject === undefined || fact.subject === query.subject)
    && (query.predicate === undefined || fact.predicate === query.predicate)
    && (query.object === undefined || fact.object === query.object))
  return query.limit === undefined ? matches : matches.slice(0, query.limit)
}

/**
 * Collect the neighbourhood of one entity out to a bounded radius, following
 * entity-valued edges in both directions.
 * @param graph - The graph to read.
 * @param entityId - The centre.
 * @param depth - Radius in edges; values below 1 are treated as 1.
 * @param includeInferred - Whether entailed edges participate.
 * @returns the reached entity ids and the facts that reached them.
 */
export function neighbors(
  graph: GraphView,
  entityId: string,
  depth: number,
  includeInferred: boolean,
): { readonly reached: string[], readonly facts: DerivedFact[] } {
  const facts = allFacts(graph, includeInferred)
  const reached = new Set<string>([entityId])
  const collected = new Map<string, DerivedFact>()
  let frontier = new Set<string>([entityId])

  for (let step = 0; step < Math.max(1, depth); step += 1) {
    const next = new Set<string>()
    for (const fact of facts) {
      const outgoing = frontier.has(fact.subject)
      const incoming = fact.objectKind === 'entity' && frontier.has(fact.object)
      if (!outgoing && !incoming) continue
      collected.set(factKey(fact.subject, fact.predicate, fact.object), fact)
      if (outgoing && fact.objectKind === 'entity' && !reached.has(fact.object)) next.add(fact.object)
      if (incoming && !reached.has(fact.subject)) next.add(fact.subject)
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
 * @returns the edges of one shortest path, or `undefined` when unreachable.
 */
export function findPath(
  graph: GraphView,
  from: string,
  to: string,
  maxDepth: number,
  includeInferred: boolean,
): DerivedFact[] | undefined {
  if (from === to) return []
  const facts = allFacts(graph, includeInferred).filter(fact => fact.objectKind === 'entity')
  const visited = new Set<string>([from])
  let frontier: { readonly id: string, readonly path: DerivedFact[] }[] = [{ id: from, path: [] }]

  for (let step = 0; step < Math.max(1, maxDepth); step += 1) {
    const next: { id: string, path: DerivedFact[] }[] = []
    for (const node of frontier) {
      for (const fact of facts) {
        const forward = fact.subject === node.id
        const other = forward ? fact.object : fact.subject
        if (!forward && fact.object !== node.id) continue
        if (visited.has(other)) continue
        const path = [...node.path, fact]
        if (other === to) return path
        visited.add(other)
        next.push({ id: other, path })
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
