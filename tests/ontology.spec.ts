/**
 * Reasoning-core tests: identifier syntax, subsumption, TBox constraint
 * checking, entailment, and graph queries.
 * @module dsh-ontology/tests/ontology
 */

import { describe, expect, it } from 'vitest'
import {
  checkId,
  classAncestors,
  classDescendants,
  entail,
  entityClasses,
  factKey,
  findPath,
  neighbors,
  queryEntities,
  queryFacts,
  renderTBox,
  statsOf,
  validateClassInput,
  validateFactInput,
  validateRelationInput,
} from '../src/ontology.ts'
import { OntologyStore } from '../src/store.ts'
import { memoryDomain } from './memory-domain.ts'

const NOW = '2026-08-16T00:00:00.000Z'

/**
 * Build an empty store over an in-memory domain.
 * @param strict - Whether TBox violations reject the write.
 * @returns the store.
 */
function newStore(strict = true): OntologyStore {
  return new OntologyStore(memoryDomain(), { strict, maxEntities: 1000, maxFacts: 5000 })
}

/**
 * Build the small service-dependency ontology the tests reuse.
 * @returns the populated store.
 */
async function serviceGraph(): Promise<OntologyStore> {
  const store = newStore()
  await store.defineClass({ id: 'Component' }, NOW)
  await store.defineClass({ id: 'Service', subClassOf: ['Component'] }, NOW)
  await store.defineClass({ id: 'Database', subClassOf: ['Component'] }, NOW)
  await store.defineClass({ id: 'Person' }, NOW)
  await store.defineRelation({
    id: 'depends_on',
    domain: ['Component'],
    range: ['Component'],
    characteristics: ['transitive'],
  }, NOW)
  // `owned_by` first: the store validates references eagerly, so an inverse must
  // exist before the relation naming it. `ontology_define` lifts that ordering
  // requirement by retrying in passes.
  await store.defineRelation({ id: 'owned_by', domain: ['Component'], range: ['Person'] }, NOW)
  await store.defineRelation({ id: 'owns', domain: ['Person'], range: ['Component'], inverseOf: 'owned_by' }, NOW)
  await store.defineRelation({ id: 'version', domain: ['Component'], rangeKind: 'literal' }, NOW)

  await store.assertEntity({ id: 'api', classes: ['Service'] }, NOW)
  await store.assertEntity({ id: 'auth', classes: ['Service'] }, NOW)
  await store.assertEntity({ id: 'pg', classes: ['Database'] }, NOW)
  await store.assertEntity({ id: 'ada', classes: ['Person'] }, NOW)
  await store.assertFact({ subject: 'api', predicate: 'depends_on', object: 'auth' }, NOW)
  await store.assertFact({ subject: 'auth', predicate: 'depends_on', object: 'pg' }, NOW)
  await store.assertFact({ subject: 'ada', predicate: 'owns', object: 'api' }, NOW)
  await store.assertFact({ subject: 'api', predicate: 'version', object: '2.1.0' }, NOW)
  return store
}

describe('identifiers', () => {
  it('accepts namespaced ids and rejects malformed ones', () => {
    expect(checkId('schema:Person', 'class')).toBeUndefined()
    expect(checkId('repo.module-a', 'class')).toBeUndefined()
    expect(checkId('', 'class')?.code).toBe('invalid-id')
    expect(checkId('9lives', 'class')?.code).toBe('invalid-id')
    expect(checkId('has space', 'class')?.code).toBe('invalid-id')
    // The separator must stay excluded or composite fact keys become ambiguous.
    expect(checkId('a|b', 'class')?.code).toBe('invalid-id')
    expect(checkId('x'.repeat(129), 'class')?.code).toBe('invalid-id')
  })

  it('joins a triple into an unambiguous key', () => {
    expect(factKey('api', 'depends_on', 'auth')).toBe('api|depends_on|auth')
  })
})

describe('subsumption', () => {
  it('closes class membership upward and downward', async () => {
    const graph = (await serviceGraph()).graph
    expect([...classAncestors(graph.terms, 'Service')].sort()).toEqual(['Component', 'Service'])
    expect([...classDescendants(graph.terms, 'Component')].sort())
      .toEqual(['Component', 'Database', 'Service'])
    expect([...entityClasses(graph, 'api')].sort()).toEqual(['Component', 'Service'])
  })

  it('refuses a subClassOf edge that would close a cycle', async () => {
    const store = newStore()
    await store.defineClass({ id: 'A' }, NOW)
    await store.defineClass({ id: 'B', subClassOf: ['A'] }, NOW)
    const violations = validateClassInput(store.graph, { id: 'A', subClassOf: ['B'] })
    expect(violations.map(violation => violation.code)).toContain('subclass-cycle')
    // Self-subsumption is the degenerate case of the same rule.
    expect(validateClassInput(store.graph, { id: 'A', subClassOf: ['A'] })
      .map(violation => violation.code)).toContain('subclass-cycle')
  })

  it('refuses an unknown superclass', () => {
    const violations = validateClassInput(newStore().graph, { id: 'A', subClassOf: ['Nope'] })
    expect(violations.map(violation => violation.code)).toEqual(['unknown-class'])
  })
})

describe('relation definitions', () => {
  it('refuses characteristics a literal-valued relation cannot have', async () => {
    const store = newStore()
    await store.defineClass({ id: 'Component' }, NOW)
    const violations = validateRelationInput(store.graph, {
      id: 'version',
      rangeKind: 'literal',
      characteristics: ['symmetric', 'transitive'],
      inverseOf: 'versioned',
      range: ['Component'],
    })
    const codes = violations.map(violation => violation.code)
    expect(codes).toContain('literal-range')
    expect(codes.filter(code => code === 'literal-characteristic')).toHaveLength(2)
    expect(codes).toContain('literal-inverse')
  })

  it('refuses an inverse that is not a defined relation', async () => {
    const store = newStore()
    const violations = validateRelationInput(store.graph, { id: 'owns', inverseOf: 'owned_by' })
    expect(violations.map(violation => violation.code)).toEqual(['unknown-relation'])
  })

  it('allows a self-inverse forward reference', async () => {
    const store = newStore()
    expect(validateRelationInput(store.graph, { id: 'sibling_of', inverseOf: 'sibling_of' })).toEqual([])
  })
})

describe('fact validation', () => {
  it('accepts a fact that satisfies domain and range', async () => {
    const graph = (await serviceGraph()).graph
    expect(validateFactInput(graph, { subject: 'api', predicate: 'depends_on', object: 'pg' })).toEqual([])
  })

  it('rejects an undeclared predicate with an actionable message', async () => {
    const graph = (await serviceGraph()).graph
    const violations = validateFactInput(graph, { subject: 'api', predicate: 'talks_to', object: 'pg' })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.code).toBe('unknown-relation')
    expect(violations[0]?.message).toContain('ontology_define')
  })

  it('rejects a subject outside the relation domain', async () => {
    const graph = (await serviceGraph()).graph
    const violations = validateFactInput(graph, { subject: 'ada', predicate: 'depends_on', object: 'api' })
    expect(violations.map(violation => violation.code)).toEqual(['domain-mismatch'])
    expect(violations[0]?.message).toContain('requires one of: Component')
  })

  it('rejects an object outside the relation range', async () => {
    const graph = (await serviceGraph()).graph
    const violations = validateFactInput(graph, { subject: 'ada', predicate: 'owns', object: 'auth' })
    expect(violations).toEqual([])
    const bad = validateFactInput(graph, { subject: 'api', predicate: 'owned_by', object: 'pg' })
    expect(bad.map(violation => violation.code)).toEqual(['range-mismatch'])
  })

  it('rejects an unknown entity in either position', async () => {
    const graph = (await serviceGraph()).graph
    expect(validateFactInput(graph, { subject: 'ghost', predicate: 'depends_on', object: 'api' })
      .map(violation => violation.code)).toEqual(['unknown-entity'])
    expect(validateFactInput(graph, { subject: 'api', predicate: 'depends_on', object: 'ghost' })
      .map(violation => violation.code)).toEqual(['unknown-entity'])
  })

  it('accepts a literal object only where the relation is literal-valued', async () => {
    const graph = (await serviceGraph()).graph
    expect(validateFactInput(graph, { subject: 'api', predicate: 'version', object: '3.0' })).toEqual([])
    expect(validateFactInput(graph, { subject: 'api', predicate: 'version', object: '' })
      .map(violation => violation.code)).toEqual(['empty-literal'])
  })

  it('enforces functional cardinality', async () => {
    const store = newStore()
    await store.defineClass({ id: 'Component' }, NOW)
    await store.defineClass({ id: 'Team' }, NOW)
    await store.defineRelation({
      id: 'maintained_by',
      domain: ['Component'],
      range: ['Team'],
      characteristics: ['functional'],
    }, NOW)
    await store.assertEntity({ id: 'api', classes: ['Component'] }, NOW)
    await store.assertEntity({ id: 'core', classes: ['Team'] }, NOW)
    await store.assertEntity({ id: 'infra', classes: ['Team'] }, NOW)

    expect((await store.assertFact({ subject: 'api', predicate: 'maintained_by', object: 'core' }, NOW)).ok)
      .toBe(true)
    const conflict = await store.assertFact({ subject: 'api', predicate: 'maintained_by', object: 'infra' }, NOW)
    expect(conflict.ok).toBe(false)
    expect(conflict.violations[0]?.code).toBe('functional-conflict')
    // Re-asserting the SAME object stays idempotent rather than conflicting.
    expect((await store.assertFact({ subject: 'api', predicate: 'maintained_by', object: 'core' }, NOW)).ok)
      .toBe(true)
  })
})

describe('non-strict mode', () => {
  it('stores a violating fact with its violations recorded', async () => {
    const store = newStore(false)
    await store.defineClass({ id: 'Person' }, NOW)
    await store.defineRelation({ id: 'owns', domain: ['Person'] }, NOW)
    await store.assertEntity({ id: 'api' }, NOW)
    await store.assertEntity({ id: 'auth' }, NOW)

    const outcome = await store.assertFact({ subject: 'api', predicate: 'owns', object: 'auth' }, NOW)
    expect(outcome.ok).toBe(true)
    expect(outcome.violations.map(violation => violation.code)).toEqual(['domain-mismatch'])
    expect(store.graph.facts.get('api|owns|auth')?.violations).toHaveLength(1)
  })
})

describe('entailment', () => {
  it('derives transitive and inverse facts without storing them', async () => {
    const store = await serviceGraph()
    const derived = entail(store.graph)
    expect(derived.some(fact =>
      fact.subject === 'api' && fact.predicate === 'depends_on' && fact.object === 'pg'
      && fact.via === 'transitive')).toBe(true)
    expect(derived.some(fact =>
      fact.subject === 'api' && fact.predicate === 'owned_by' && fact.object === 'ada'
      && fact.via === 'inverse')).toBe(true)
    // Derivation is read-only: nothing new reached the medium.
    expect(statsOf(store.graph).facts).toBe(4)
  })

  it('derives symmetric facts in both directions', async () => {
    const store = newStore()
    await store.defineClass({ id: 'Person' }, NOW)
    await store.defineRelation({
      id: 'collaborates_with',
      domain: ['Person'],
      range: ['Person'],
      characteristics: ['symmetric'],
    }, NOW)
    await store.assertEntity({ id: 'ada', classes: ['Person'] }, NOW)
    await store.assertEntity({ id: 'grace', classes: ['Person'] }, NOW)
    await store.assertFact({ subject: 'ada', predicate: 'collaborates_with', object: 'grace' }, NOW)

    const derived = entail(store.graph)
    expect(derived).toHaveLength(1)
    expect(derived[0]).toMatchObject({ subject: 'grace', object: 'ada', via: 'symmetric' })
  })

  it('terminates on a cyclic transitive relation', async () => {
    const store = newStore()
    await store.defineClass({ id: 'Node' }, NOW)
    await store.defineRelation({
      id: 'reaches',
      domain: ['Node'],
      range: ['Node'],
      characteristics: ['transitive'],
    }, NOW)
    for (const id of ['a', 'b', 'c']) await store.assertEntity({ id, classes: ['Node'] }, NOW)
    await store.assertFact({ subject: 'a', predicate: 'reaches', object: 'b' }, NOW)
    await store.assertFact({ subject: 'b', predicate: 'reaches', object: 'c' }, NOW)
    await store.assertFact({ subject: 'c', predicate: 'reaches', object: 'a' }, NOW)

    const derived = entail(store.graph)
    // Every ordered pair of distinct nodes is reachable; self-loops are excluded.
    expect(derived).toHaveLength(3)
    expect(derived.every(fact => fact.subject !== fact.object)).toBe(true)
  })

  it('honors the derivation limit', async () => {
    const store = await serviceGraph()
    expect(entail(store.graph, 1)).toHaveLength(1)
  })

  it('drops entailments once their premise is retracted', async () => {
    const store = await serviceGraph()
    await store.retractFact('auth', 'depends_on', 'pg')
    expect(entail(store.graph).some(fact => fact.subject === 'api' && fact.object === 'pg')).toBe(false)
  })
})

describe('queries', () => {
  it('finds entities through subclasses', async () => {
    const graph = (await serviceGraph()).graph
    expect(queryEntities(graph, { classId: 'Component' }).map(entity => entity.id))
      .toEqual(['api', 'auth', 'pg'])
    expect(queryEntities(graph, { classId: 'Service' }).map(entity => entity.id)).toEqual(['api', 'auth'])
  })

  it('matches a triple pattern, optionally including entailments', async () => {
    const graph = (await serviceGraph()).graph
    expect(queryFacts(graph, { subject: 'api', predicate: 'depends_on' }).map(fact => fact.object))
      .toEqual(['auth'])
    expect(queryFacts(graph, { subject: 'api', predicate: 'depends_on', includeInferred: true })
      .map(fact => fact.object).sort()).toEqual(['auth', 'pg'])
  })

  it('expands a neighbourhood to a bounded depth', async () => {
    const graph = (await serviceGraph()).graph
    expect(neighbors(graph, 'api', 1, false).reached.sort()).toEqual(['ada', 'api', 'auth'])
    expect(neighbors(graph, 'api', 2, false).reached.sort()).toEqual(['ada', 'api', 'auth', 'pg'])
  })

  it('finds a shortest path regardless of assertion direction', async () => {
    const graph = (await serviceGraph()).graph
    const path = findPath(graph, 'ada', 'pg', 4, false)
    expect(path?.map(fact => fact.predicate)).toEqual(['owns', 'depends_on', 'depends_on'])
    expect(findPath(graph, 'ada', 'pg', 2, false)).toBeUndefined()
    expect(findPath(graph, 'api', 'api', 4, false)).toEqual([])
  })
})

describe('presentation', () => {
  it('renders the vocabulary compactly and notes elision', async () => {
    const graph = (await serviceGraph()).graph
    const lines = renderTBox(graph, 100)
    expect(lines).toContain('class Service < Component')
    expect(lines).toContain('rel depends_on: Component -> Component [transitive]')
    expect(lines).toContain('rel version: Component -> literal')
    expect(lines).toContain('rel owns: Person -> Component [inverseOf owned_by]')
    expect(renderTBox(graph, 2).at(-1)).toContain('more terms')
  })
})
