/**
 * CPU benchmark over the in-memory domain: bulk assert, entailment,
 * pattern queries, neighbourhood and path on a synthetic dependency graph.
 * Usage: node bench/bench.ts [entities] [factsPerEntity]
 */
import { performance } from 'node:perf_hooks'
import { OntologyStore } from '../src/store.ts'
import { createOntologyTools } from '../src/tools.ts'
import { memoryDomain } from '../tests/memory-domain.ts'

const N = Number(process.argv[2] ?? 2000)
const K = Number(process.argv[3] ?? 3)
const store = new OntologyStore(memoryDomain(), { strict: true, maxEntities: 10 ** 6, maxFacts: 10 ** 7 })
const tools = createOntologyTools({ store, inference: true, defaultLimit: 50, maxLimit: 500, now: () => '2026-01-01T00:00:00.000Z' })
const tool = (name: string) => tools.find(t => t.name === name)!
const call = (name: string, args: unknown) => (tool(name) as any).execute(args)

const t = async (label: string, fn: () => Promise<unknown> | unknown) => {
  const start = performance.now()
  const out = await fn()
  const ms = performance.now() - start
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms`)
  return out
}

await call('ontology_define', {
  classes: [{ id: 'Component' }, { id: 'Service', subClassOf: ['Component'] }, { id: 'Person' }],
  relations: [
    { id: 'depends_on', domain: ['Component'], range: ['Component'], characteristics: ['transitive'] },
    { id: 'owned_by', domain: ['Component'], range: ['Person'], characteristics: ['functional'] },
    { id: 'owns', domain: ['Person'], range: ['Component'], inverseOf: 'owned_by' },
    { id: 'peer_of', domain: ['Component'], range: ['Component'], characteristics: ['symmetric'] },
    { id: 'version', domain: ['Component'], rangeKind: 'literal' },
  ],
})

const entities = Array.from({ length: N }, (_, i) => ({ id: `c${i}`, classes: [i % 2 ? 'Service' : 'Component'] }))
entities.push(...Array.from({ length: Math.ceil(N / 20) }, (_, i) => ({ id: `p${i}`, classes: ['Person'] })))
// Layered DAG: each node depends on K nodes in the next layer of 100.
const facts: { subject: string, predicate: string, object: string }[] = []
for (let i = 0; i < N; i += 1) {
  for (let k = 1; k <= K; k += 1) {
    const j = i + 100 * k + (i % 7)
    if (j < N) facts.push({ subject: `c${i}`, predicate: 'depends_on', object: `c${j}` })
  }
  facts.push({ subject: `c${i}`, predicate: 'owned_by', object: `p${i % Math.ceil(N / 20)}` })
  facts.push({ subject: `c${i}`, predicate: 'version', object: `1.${i}.0` })
  if (i % 10 === 0 && i + 1 < N) facts.push({ subject: `c${i}`, predicate: 'peer_of', object: `c${i + 1}` })
}
console.log(`entities=${entities.length} facts=${facts.length}`)

const chunk = 500
await t(`assert entities (${entities.length}) in chunks of ${chunk}`, async () => {
  for (let i = 0; i < entities.length; i += chunk) await call('ontology_assert', { entities: entities.slice(i, i + chunk) })
})
await t(`assert facts (${facts.length}) in chunks of ${chunk}`, async () => {
  for (let i = 0; i < facts.length; i += chunk) {
    const r = await call('ontology_assert', { facts: facts.slice(i, i + chunk) })
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected[0]))
  }
})
const stats = await t('query stats (full entailment)', () => call('ontology_query', { mode: 'stats' }))
console.log('  ', JSON.stringify(stats.stats))
await t('query stats again (same generation)', () => call('ontology_query', { mode: 'stats' }))
await t('query facts subject=c0 inferred', () => call('ontology_query', { mode: 'facts', subject: 'c0', includeInferred: true, limit: 500 }))
await t('query facts predicate=owns inferred', () => call('ontology_query', { mode: 'facts', predicate: 'owns', includeInferred: true, limit: 500 }))
await t('query facts subject=c5 asserted', () => call('ontology_query', { mode: 'facts', subject: 'c5' }))
await t('query entities class=Component', () => call('ontology_query', { mode: 'entities', class: 'Component', limit: 500 }))
await t('neighbors c0 depth 3', () => call('ontology_query', { mode: 'neighbors', entity: 'c0', depth: 3, limit: 500 }))
await t('path c0 -> last depth 8 inferred', () => call('ontology_query', { mode: 'path', from: 'c0', to: `c${N - 1}`, depth: 8, includeInferred: true }))
await t('assert 1 fact then stats (cache bust)', async () => {
  await call('ontology_assert', { entities: [{ id: 'extra', classes: ['Component'] }], facts: [{ subject: 'extra', predicate: 'depends_on', object: 'c0' }] })
  return call('ontology_query', { mode: 'stats' })
})
await t('retract entity c1 (cascade)', () => call('ontology_retract', { entities: ['c1'] }))
