/**
 * Tool-surface tests: argument validation, the define tool's order-independent
 * resolution, assert/query/retract behavior, and the rendered model-facing
 * content. Tools run through the real `defineTool` wrapper, so these also check
 * that the declared parameter and output schemas match what `execute` produces.
 * @module dsh-ontology/tests/tools
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderOntologySection } from '../src/prompt.ts'
import { assertDomainName } from '../src/spec.ts'
import { OntologyStore } from '../src/store.ts'
import { createOntologyTools } from '../src/tools.ts'
import { memoryDomain } from './memory-domain.ts'

const NOW = '2026-08-16T00:00:00.000Z'

let store: OntologyStore
let tools: Map<string, ToolDefinition>

beforeEach(() => {
  store = new OntologyStore(memoryDomain(), { strict: true, maxEntities: 100, maxFacts: 500 })
  tools = new Map(createOntologyTools({
    store,
    inference: true,
    defaultLimit: 50,
    maxLimit: 500,
    now: () => NOW,
  }).map(tool => [tool.name, tool]))
})

/**
 * Invoke one tool the way the registry would.
 * @param name - Tool name.
 * @param args - Model-supplied arguments.
 * @returns the canonical result value.
 */
async function run(name: string, args: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
  return await tool.execute(args, exec) as Record<string, unknown>
}

/**
 * Render one tool result as the model would see it.
 * @param name - Tool name.
 * @param args - The arguments that produced the value.
 * @param value - The canonical result value.
 * @returns the rendered text.
 */
function render(name: string, args: unknown, value: unknown): string {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  const blocks = tool.output.render(args as never, value as never)
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

/** Declare the reusable service/person vocabulary through the define tool. */
async function defineVocabulary(): Promise<Record<string, unknown>> {
  return await run('ontology_define', {
    // Deliberately reversed: Service references Component before it exists, and
    // `owns` references its inverse before it exists.
    classes: [
      { id: 'Service', subClassOf: ['Component'] },
      { id: 'Component', comment: 'A deployable unit of the system' },
      { id: 'Person' },
    ],
    relations: [
      { id: 'owns', domain: ['Person'], range: ['Component'], inverseOf: 'owned_by' },
      { id: 'owned_by', domain: ['Component'], range: ['Person'] },
      { id: 'depends_on', domain: ['Component'], range: ['Component'], characteristics: ['transitive'] },
    ],
  })
}

describe('ontology_define', () => {
  it('resolves definitions regardless of the order they arrive in', async () => {
    const value = await defineVocabulary()
    expect(value.rejected).toEqual([])
    expect(value.classes).toEqual(expect.arrayContaining(['Component', 'Service', 'Person']))
    expect(value.relations).toEqual(expect.arrayContaining(['owns', 'owned_by', 'depends_on']))
  })

  it('reports the reason for a definition that can never resolve', async () => {
    const value = await run('ontology_define', {
      classes: [{ id: 'Service', subClassOf: ['DoesNotExist'] }],
    })
    expect(value.classes).toEqual([])
    expect(value.rejected).toEqual([
      { ref: 'Service', violations: ['superclass DoesNotExist of Service is not defined'] },
    ])
    expect(render('ontology_define', {}, value)).toContain('REJECTED Service')
  })

  it('rejects arguments that violate the declared parameter schema', async () => {
    await expect(run('ontology_define', { classes: [{ label: 'no id' }] })).rejects.toThrow()
    await expect(run('ontology_define', { classes: [{ id: 'A', bogus: 1 }] })).rejects.toThrow()
    await expect(run('ontology_define', { relations: [{ id: 'r', rangeKind: 'nonsense' }] })).rejects.toThrow()
  })
})

describe('ontology_assert', () => {
  beforeEach(async () => {
    await defineVocabulary()
  })

  it('creates entities before the facts of the same call', async () => {
    const value = await run('ontology_assert', {
      entities: [
        { id: 'api', classes: ['Service'] },
        { id: 'auth', classes: ['Service'] },
        { id: 'ada', classes: ['Person'] },
      ],
      facts: [
        { subject: 'api', predicate: 'depends_on', object: 'auth' },
        { subject: 'ada', predicate: 'owns', object: 'api', source: 'CODEOWNERS' },
      ],
    })
    expect(value.rejected).toEqual([])
    expect(value.entities).toEqual(['api', 'auth', 'ada'])
    expect(value.facts).toHaveLength(2)
  })

  it('rejects a fact that breaks the declared model and says which constraint failed', async () => {
    await run('ontology_assert', { entities: [{ id: 'api', classes: ['Service'] }, { id: 'ada', classes: ['Person'] }] })
    const value = await run('ontology_assert', {
      facts: [{ subject: 'ada', predicate: 'depends_on', object: 'api' }],
    })
    expect(value.facts).toEqual([])
    const rejected = value.rejected as { ref: string, violations: string[] }[]
    expect(rejected[0]?.ref).toBe('ada depends_on api')
    expect(rejected[0]?.violations[0]).toContain('not in the domain of depends_on')
    expect(render('ontology_assert', {}, value)).toContain('REJECTED')
  })

  it('accumulates an entity\'s classes across calls', async () => {
    await run('ontology_assert', { entities: [{ id: 'api', classes: ['Service'] }] })
    await run('ontology_assert', { entities: [{ id: 'api', classes: ['Person'], label: 'API' }] })
    expect(store.graph.entities.get('api')?.classes).toEqual(['Service', 'Person'])
    expect(store.graph.entities.get('api')?.label).toBe('API')
  })
})

describe('ontology_query', () => {
  beforeEach(async () => {
    await defineVocabulary()
    await run('ontology_assert', {
      entities: [
        { id: 'api', classes: ['Service'], comment: 'public HTTP surface' },
        { id: 'auth', classes: ['Service'] },
        { id: 'pg', classes: ['Component'] },
        { id: 'ada', classes: ['Person'] },
      ],
      facts: [
        { subject: 'api', predicate: 'depends_on', object: 'auth' },
        { subject: 'auth', predicate: 'depends_on', object: 'pg' },
        { subject: 'ada', predicate: 'owns', object: 'api' },
      ],
    })
  })

  it('reports counts including what is inferable', async () => {
    const value = await run('ontology_query', { mode: 'stats' })
    expect(value.stats).toMatchObject({ classes: 3, relations: 3, entities: 4, facts: 3 })
    expect((value.stats as { inferredFacts: number }).inferredFacts).toBeGreaterThan(0)
  })

  it('lists the vocabulary', async () => {
    const value = await run('ontology_query', { mode: 'schema' })
    expect(value.schema).toContain('class Service < Component')
    expect(render('ontology_query', { mode: 'schema' }, value)).toContain('rel depends_on')
  })

  it('finds entities through subclasses and by text', async () => {
    const byClass = await run('ontology_query', { mode: 'entities', class: 'Component' })
    expect((byClass.entities as { id: string }[]).map(entity => entity.id)).toEqual(['api', 'auth', 'pg'])
    const bySearch = await run('ontology_query', { mode: 'entities', search: 'HTTP' })
    expect((bySearch.entities as { id: string }[]).map(entity => entity.id)).toEqual(['api'])
  })

  it('returns entailed facts only when asked, marked with their derivation', async () => {
    const asserted = await run('ontology_query', { mode: 'facts', subject: 'api', predicate: 'depends_on' })
    expect(asserted.facts).toHaveLength(1)

    const inferred = await run('ontology_query', {
      mode: 'facts',
      subject: 'api',
      predicate: 'depends_on',
      includeInferred: true,
    })
    const facts = inferred.facts as { object: string, via: string }[]
    expect(facts).toHaveLength(2)
    expect(facts.find(fact => fact.object === 'pg')?.via).toBe('transitive')
    expect(render('ontology_query', { mode: 'facts' }, inferred)).toContain('(inferred: transitive)')
  })

  it('truncates a result and says so', async () => {
    const value = await run('ontology_query', { mode: 'entities', limit: 2 })
    expect(value.entities).toHaveLength(2)
    expect(value.truncated).toBe(true)
    expect(render('ontology_query', { mode: 'entities' }, value)).toContain('truncated')
  })

  it('connects two entities through a relation chain', async () => {
    const value = await run('ontology_query', { mode: 'path', from: 'ada', to: 'pg', depth: 4 })
    expect(value.connected).toBe(true)
    expect((value.path as { predicate: string }[]).map(fact => fact.predicate))
      .toEqual(['owns', 'depends_on', 'depends_on'])

    const unreachable = await run('ontology_query', { mode: 'path', from: 'ada', to: 'pg', depth: 1 })
    expect(unreachable.connected).toBe(false)
    expect(render('ontology_query', { mode: 'path' }, unreachable)).toContain('no path')
  })

  it('fails loudly when a mode is missing its required argument', async () => {
    await expect(run('ontology_query', { mode: 'neighbors' })).rejects.toThrow(/requires "entity"/)
    await expect(run('ontology_query', { mode: 'path', from: 'ada' })).rejects.toThrow(/requires "from" and "to"/)
    await expect(run('ontology_query', { mode: 'nope' })).rejects.toThrow()
  })
})

describe('ontology_retract', () => {
  beforeEach(async () => {
    await defineVocabulary()
    await run('ontology_assert', {
      entities: [{ id: 'api', classes: ['Service'] }, { id: 'auth', classes: ['Service'] }],
      facts: [{ subject: 'api', predicate: 'depends_on', object: 'auth' }],
    })
  })

  it('removes an entity together with the facts mentioning it', async () => {
    const value = await run('ontology_retract', { entities: ['auth'] })
    expect(value.entities).toEqual(['auth'])
    expect(value.cascadedFacts).toBe(1)
    expect(store.graph.facts.size).toBe(0)
  })

  it('refuses a term that is still in use, and says what uses it', async () => {
    const value = await run('ontology_retract', { terms: ['Service', 'depends_on'] })
    expect(value.terms).toEqual([])
    const refused = value.refused as { ref: string, violations: string[] }[]
    expect(refused.map(item => item.ref).sort()).toEqual(['Service', 'depends_on'])
    expect(refused.find(item => item.ref === 'Service')?.violations[0]).toContain('still classifies entity')
    expect(render('ontology_retract', {}, value)).toContain('REFUSED')
  })

  it('allows the term once its dependents are gone', async () => {
    await run('ontology_retract', { entities: ['api', 'auth'] })
    const value = await run('ontology_retract', { terms: ['depends_on'] })
    expect(value.terms).toEqual(['depends_on'])
  })

  it('reports absent targets rather than failing', async () => {
    const value = await run('ontology_retract', {
      entities: ['ghost'],
      facts: [{ subject: 'api', predicate: 'depends_on', object: 'ghost' }],
    })
    expect(value.missing).toEqual(['ghost', 'api depends_on ghost'])
  })
})

describe('configuration boundary', () => {
  it('names the offending setting when the domain name is illegal', () => {
    expect(() => assertDomainName('ontology-smoke')).toThrow(/invalid "domain" setting/)
    expect(() => assertDomainName('Ontology')).toThrow(TypeError)
    expect(() => assertDomainName('')).toThrow(TypeError)
    expect(assertDomainName('team_ontology')).toBe('team_ontology')
  })
})

describe('system prompt section', () => {
  it('invites the model to populate an empty graph', () => {
    const text = renderOntologySection(store.graph, 60)
    expect(text).toContain('currently EMPTY')
    expect(text).toContain('ontology_define')
  })

  it('carries the vocabulary but not the counts once populated', async () => {
    await defineVocabulary()
    await run('ontology_assert', { entities: [{ id: 'api', classes: ['Service'] }] })
    const text = renderOntologySection(store.graph, 60)
    expect(text).toContain('- class Service < Component')
    // Counts change on every write and would bust the cached prompt prefix.
    expect(text).not.toMatch(/\d+ (classes|entities|facts)/)
    // Instance data stays behind the query tool; only vocabulary is standing context.
    expect(text).not.toContain('api')
  })

  it('elides vocabulary past the configured bound', async () => {
    await defineVocabulary()
    expect(renderOntologySection(store.graph, 2)).toContain('more terms')
  })
})
