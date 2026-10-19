/**
 * Guards on the ingest tool's registration surface.
 *
 * Both of the things asserted here were real failures caught late:
 *
 * 1. `defineTool` validates and compiles `parameters` at registration time, so
 *    a schema it cannot compile does not degrade — it throws while the plugin
 *    is mounting, taking the core tools down with it. An `as any` cast had
 *    hidden exactly that.
 * 2. `pg` and `mysql2` are optional peer dependencies, but this plugin is
 *    imported by every profile that lists it. A static `import` of either
 *    would make a driver mandatory for someone who never calls the tool.
 * @module dsh-ontology/tests/ingest/tool
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { memoryDomain } from '../memory-domain.ts'
import { OntologyStore } from '../../src/store.ts'
import { createIngestTools } from '../../src/ingest/index.ts'

function store(): OntologyStore {
  return new OntologyStore(memoryDomain(), { strict: true, maxEntities: 100, maxFacts: 100 })
}

describe('ontology_ingest_db registration', () => {
  it('registers without throwing', () => {
    // `defineTool` compiles the parameter schema here; an uncompilable one
    // throws at this line, which is what mounting the plugin does.
    expect(() => createIngestTools({ store: store() })).not.toThrow()
  })

  it('declares the connection, mapping, and options blocks', () => {
    const [tool] = createIngestTools({ store: store() })
    const schema = tool!.parameters as {
      properties: Record<string, { properties: Record<string, unknown> }>
      required: string[]
    }

    expect(Object.keys(schema.properties).sort()).toEqual(['connection', 'mapping', 'options'])
    expect(schema.required.sort()).toEqual(['connection', 'mapping'])

    expect(Object.keys(schema.properties.connection!.properties).sort()).toEqual([
      'connectionTimeout', 'database', 'host', 'password', 'port', 'ssl', 'type', 'user',
    ])
    expect(Object.keys(schema.properties.mapping!.properties).sort()).toEqual([
      'globalPrefix', 'tables',
    ])
  })

  it('enumerates the supported database types and modes', () => {
    const [tool] = createIngestTools({ store: store() })
    const schema = tool!.parameters as {
      properties: {
        connection: { properties: { type: { enum: string[] } } }
        options: { properties: { mode: { enum: string[] } } }
      }
    }

    expect(schema.properties.connection.properties.type.enum).toEqual(['mysql', 'postgres'])
    expect(schema.properties.options.properties.mode.enum).toEqual([
      'full', 'incremental', 'dry-run',
    ])
  })

  it('nests the per-table attribute and foreign key shapes', () => {
    const [tool] = createIngestTools({ store: store() })
    const tables = (tool!.parameters as {
      properties: {
        mapping: {
          properties: {
            tables: {
              items: {
                properties: {
                  attributes: { items: { properties: Record<string, unknown> } }
                  foreignKeys: { items: { properties: Record<string, unknown> } }
                }
              }
            }
          }
        }
      }
    }).properties.mapping.properties.tables.items

    expect(Object.keys(tables.properties.foreignKeys.items.properties).sort()).toEqual([
      'column', 'nullable', 'relation', 'targetTable',
    ])
    expect(Object.keys(tables.properties.attributes.items.properties).sort()).toEqual([
      'column', 'relation', 'transform',
    ])
  })

  it('renders a result into content blocks', () => {
    const [tool] = createIngestTools({ store: store() })

    const blocks = tool!.output.render(
      {},
      {
        success: true,
        mode: 'full',
        stats: {
          tablesProcessed: 1,
          entitiesCreated: 3,
          factsCreated: 2,
          rowsSkipped: 0,
          duration: 12,
        },
        tables: [{
          table: 'users',
          rowsRead: 3,
          entitiesCreated: 3,
          factsCreated: 2,
          errors: 0,
          warnings: 1,
          duration: 12,
        }],
        errors: [],
        warnings: [{ table: 'users', type: 'null-fk', message: '1 row has NULL manager_id' }],
      },
    )

    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type).toBe('text')
    if (block.type !== 'text') throw new Error(`expected a text block, got ${block.type}`)
    expect(block.text).toContain('3 entit(ies)')
    expect(block.text).toContain('WARNING users')
  })
})

describe('database drivers stay optional', () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../src/ingest/connectors/${name}`, import.meta.url)), 'utf8')

  it.each([
    ['postgres.ts', 'pg'],
    ['mysql.ts', 'mysql2/promise'],
  ])('%s imports %s dynamically, not statically', (file, driver) => {
    const text = source(file)

    // A value import — `import x from 'pg'` or a bare `import 'pg'` — is what
    // would drag the driver into every profile. `import type` is erased, so
    // the negative lookahead lets it through.
    const valueImport = new RegExp(
      `^\\s*import\\s+(?!type\\s)[^;]*?['"]${driver}['"]`,
      'm',
    )
    expect(text).not.toMatch(valueImport)

    const dynamicImport = new RegExp(`import\\(\\s*['"]${driver}['"]\\s*\\)`)
    expect(text).toMatch(dynamicImport)
  })
})
