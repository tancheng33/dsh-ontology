/**
 * The database ingestion tool: `ontology_ingest_db` reads a MySQL or
 * PostgreSQL schema into the graph, with foreign keys becoming relations.
 *
 * Written against the same `defineTool` contract as the core tools — a plain
 * JSON-schema `parameters` map, and an `output.render` returning content
 * blocks — so its argument validation is the harness's, not this module's.
 * @module dsh-ontology/ingest
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OntologyStore } from '../store.ts'
import { ingestFromDatabase } from './engine.ts'
import type { IngestDbInput, IngestDbOutput, IngestError, IngestWarning } from './types.ts'
import { formatDuration } from './utils.ts'

export * from './types.ts'
export { ingestFromDatabase } from './engine.ts'

/** Runtime knobs the ingest tool reads from the plugin. */
export interface IngestToolContext {
  readonly store: OntologyStore
}

/** A connection block, shared by the tool's parameters and its docs. */
const connectionParameters = {
  type: {
    type: 'string',
    required: true,
    enum: ['mysql', 'postgres'],
    description: 'Which server is being read',
  },
  host: { type: 'string', required: true, description: 'Hostname or IP' },
  port: { type: 'integer', description: 'Port (default 3306 for MySQL, 5432 for PostgreSQL)' },
  database: { type: 'string', required: true, description: 'Database name' },
  user: { type: 'string', required: true, description: 'Database user; read-only access is enough' },
  password: {
    type: 'string',
    required: true,
    description: 'Password, or ${ENV_VAR} to read it from the environment instead of inlining it',
  },
  ssl: { type: 'boolean', description: 'Use TLS for the connection' },
  connectionTimeout: { type: 'integer', description: 'Connect timeout in milliseconds (default 10000)' },
} as const

const tableParameters = {
  table: { type: 'string', required: true, description: 'Table to read' },
  entityClass: {
    type: 'string',
    required: true,
    description: 'Class to declare its rows as; must already exist in the vocabulary',
  },
  idColumn: {
    type: 'string',
    required: true,
    description: 'Primary key column; its value forms the entity id as <table>_<value>',
  },
  labelColumn: {
    type: 'string',
    description: 'Column to use as the entity label — what a text search matches',
  },
  commentColumn: { type: 'string', description: 'Column to use as the entity comment' },
  where: {
    type: 'string',
    description: 'SQL condition limiting which rows are read, e.g. "deleted_at IS NULL"',
  },
  entityIdTemplate: {
    type: 'string',
    description: 'Override the id shape; ${table}, ${id}, and ${prefix} are substituted',
  },
  attributes: {
    type: 'array',
    description: 'Columns to map as literal-valued relations',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        column: { type: 'string', required: true, description: 'Column to read' },
        relation: {
          type: 'string',
          required: true,
          description: 'Relation name; must be declared with rangeKind "literal"',
        },
        transform: {
          type: 'string',
          enum: ['lowercase', 'uppercase', 'trim'],
          description: 'Applied to the value before it is stored',
        },
      },
    },
  },
  foreignKeys: {
    type: 'array',
    description: 'Foreign keys to map as entity-valued relations',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        column: { type: 'string', required: true, description: 'The foreign key column' },
        targetTable: {
          type: 'string',
          required: true,
          description: 'Referenced table; its class must already be declared',
        },
        relation: { type: 'string', required: true, description: 'Relation name to assert' },
        nullable: {
          type: 'boolean',
          description: 'Whether a NULL is acceptable (default true: the fact is skipped and reported)',
        },
      },
    },
  },
} as const

/** The canonical result shape `output.schema` declares. */
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', required: true },
    mode: { type: 'string', required: true },
    stats: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        tablesProcessed: { type: 'integer', required: true },
        entitiesCreated: { type: 'integer', required: true },
        factsCreated: { type: 'integer', required: true },
        rowsSkipped: { type: 'integer', required: true },
        duration: { type: 'integer', required: true },
      },
    },
    tables: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', required: true },
          rowsRead: { type: 'integer', required: true },
          entitiesCreated: { type: 'integer', required: true },
          factsCreated: { type: 'integer', required: true },
          errors: { type: 'integer', required: true },
          warnings: { type: 'integer', required: true },
          duration: { type: 'integer', required: true },
        },
      },
    },
    errors: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', required: true },
          row: { type: 'integer' },
          type: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
    warnings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', required: true },
          type: { type: 'string', required: true },
          message: { type: 'string', required: true },
          count: { type: 'integer' },
        },
      },
    },
    preview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        wouldCreateEntities: { type: 'integer', required: true },
        wouldCreateFacts: { type: 'integer', required: true },
        sampleEntities: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              classes: { type: 'array', required: true, items: { type: 'string' } },
              label: { type: 'string' },
            },
          },
        },
        sampleFacts: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              subject: { type: 'string', required: true },
              predicate: { type: 'string', required: true },
              object: { type: 'string', required: true },
            },
          },
        },
      },
    },
  },
} as const

/**
 * The value the harness hands `render`: the declared output schema, in which
 * the enum-ish fields are bare strings rather than the internal unions.
 */
type IngestRenderValue =
  Omit<IngestDbOutput, 'mode' | 'errors' | 'warnings'> & {
    readonly mode: string
    readonly errors: readonly (Omit<IngestError, 'type'> & { readonly type: string })[]
    readonly warnings: readonly (Omit<IngestWarning, 'type'> & { readonly type: string })[]
  }

/**
 * Render an ingestion result as prose for the model.
 * @param result - The canonical value.
 * @returns the text.
 */
function renderIngest(result: IngestRenderValue): string {
  const lines: string[] = []

  if (result.mode === 'dry-run' && result.preview !== undefined) {
    lines.push(`DRY RUN — nothing written (${formatDuration(result.stats.duration)})`)
    lines.push(
      `would create ${result.preview.wouldCreateEntities} entit(ies), `
      + `${result.preview.wouldCreateFacts} fact(s)`,
    )
    if (result.preview.sampleEntities.length > 0) {
      lines.push('sample entities:')
      for (const entity of result.preview.sampleEntities) {
        const label = entity.label === undefined ? '' : ` ${JSON.stringify(entity.label)}`
        lines.push(`  ${entity.id} (${entity.classes.join(', ')})${label}`)
      }
    }
    if (result.preview.sampleFacts.length > 0) {
      lines.push('sample facts:')
      for (const fact of result.preview.sampleFacts) {
        lines.push(`  ${fact.subject} ${fact.predicate} ${fact.object}`)
      }
    }
  } else {
    lines.push(
      `ingested ${result.stats.entitiesCreated} entit(ies) and ${result.stats.factsCreated} `
      + `fact(s) in ${formatDuration(result.stats.duration)} (mode: ${result.mode})`,
    )
    for (const table of result.tables) {
      lines.push(
        `  ${table.table}: ${table.entitiesCreated} entit(ies), ${table.factsCreated} fact(s) `
        + `from ${table.rowsRead} row(s)`,
      )
    }
  }

  for (const warning of result.warnings) {
    lines.push(`WARNING ${warning.table}: ${warning.message}`)
  }
  for (const error of result.errors) {
    const where = error.table === '' ? '' : `${error.table}: `
    lines.push(`ERROR ${where}${error.message}`)
  }

  return lines.join('\n')
}

/**
 * Build the `ontology_ingest_db` tool: loads a relational schema into the
 * graph, with foreign keys becoming the relations between entities.
 * @param context - Tool configuration.
 * @returns the tool definition.
 */
export function defineOntologyIngestTool(context: IngestToolContext): ToolDefinition {
  return defineTool({
    name: 'ontology_ingest_db',
    description:
      'Import a MySQL or PostgreSQL database into the ontology: one table becomes one class, one row '
      + 'becomes one entity, and each foreign key becomes an entity-valued relation. Declare the '
      + 'vocabulary with ontology_define FIRST — the entityClass of every table, and both sides of '
      + 'every relation, must already exist or the import refuses before reading a row. A mapped '
      + 'column that is not a foreign key becomes a literal-valued relation (declare it with '
      + 'rangeKind "literal"), and a NULL value there is skipped rather than stored as an empty '
      + 'string. Entity ids are "<table>_<primary key>", so two tables never collide. Foreign keys '
      + 'only assert one direction: declare the reverse relation with "inverseOf" and the query '
      + 'engine derives it, and a self-referencing foreign key marked "transitive" turns one stored '
      + 'hop into a whole chain. Importing the same rows twice is idempotent, so a full re-sync is '
      + 'safe. Use options.mode "dry-run" to see what would be written, with sample entities and '
      + 'facts, before committing to it. Warnings report rows that were imported with a NULL foreign '
      + 'key skipped; errors report rows that were rejected by the vocabulary.',
    parameters: {
      connection: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'How to reach the database. Only reads are issued.',
        properties: connectionParameters,
      },
      mapping: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'What each table and column means',
        properties: {
          globalPrefix: {
            type: 'string',
            description: 'Prefix for every entity id, to keep two imports of the same table apart',
          },
          tables: {
            type: 'array',
            required: true,
            description: 'Per-table mappings; order does not matter',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: tableParameters,
            },
          },
        },
      },
      options: {
        type: 'object',
        additionalProperties: false,
        description: 'Import behaviour',
        properties: {
          mode: {
            type: 'string',
            enum: ['full', 'incremental', 'dry-run'],
            description: '"full" (default) reads every row; "incremental" only those past lastSyncTime; '
              + '"dry-run" reports without writing',
          },
          batchSize: { type: 'integer', description: 'Rows fetched and written per batch (default 500)' },
          limit: { type: 'integer', description: 'Stop after this many rows per table' },
          timestampColumn: {
            type: 'string',
            description: 'incremental mode: the column to compare against lastSyncTime',
          },
          lastSyncTime: {
            type: 'string',
            description: 'incremental mode: ISO 8601 timestamp; only newer rows are read',
          },
          continueOnError: {
            type: 'boolean',
            description: 'Carry on to later tables after a failure (default false)',
          },
        },
      },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: renderIngest(value) }],
    },
    async execute(args) {
      // The schema above is what validates `args`; its enum fields infer as
      // `string` here, so this is a narrowing at a checked boundary rather
      // than an unchecked cast.
      return await ingestFromDatabase(args as IngestDbInput, context.store)
    },
    presentCall: args => {
      const tables = args.mapping?.tables?.length ?? 0
      return {
        card: 'generic',
        kind: 'edit',
        title: `ontology ingest db (${tables} table${tables === 1 ? '' : 's'}`
          + `${args.options?.mode === undefined ? '' : `, ${args.options.mode}`})`,
      }
    },
  })
}

/**
 * Create the ingestion tools.
 * @param context - Tool configuration.
 * @returns the tool definitions.
 */
export function createIngestTools(context: IngestToolContext): ToolDefinition[] {
  return [defineOntologyIngestTool(context)]
}
