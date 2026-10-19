/**
 * Core ingestion engine - orchestrates the entire import process
 * @module dsh-ontology/ingest/engine
 */

import type { OntologyStore } from '../store.ts'
import type { DbConnector } from './connectors/base.ts'
import type {
  IngestDbInput,
  IngestDbOutput,
  IngestOptions,
  TableIngestResult,
  IngestError,
  IngestWarning,
  TableMapping,
} from './types.ts'
import { connectDatabase } from './connectors/factory.ts'
import { validateMapping, validateEntityClasses } from './validator.ts'
import { transformRows, createPreview } from './transformer.ts'
import { resolveEnvVars, hasEnvVar } from './utils.ts'

/**
 * Execute database ingestion
 */
export async function ingestFromDatabase(
  input: IngestDbInput,
  store: OntologyStore,
): Promise<IngestDbOutput> {
  const startTime = Date.now()
  const diagnostics: Diagnostics = { warnings: [], errors: [] }
  const tableResults: TableIngestResult[] = []

  let connector: DbConnector | null = null

  try {
    // Resolve environment variables in connection config
    const connection = { ...input.connection }
    if (hasEnvVar(connection.password)) {
      connection.password = resolveEnvVars(connection.password)
    }

    // Connect to database
    connector = await connectDatabase(connection)

    // Validate mapping configuration
    const validation = await validateMapping(connector, input.mapping)
    if (!validation.valid) {
      return {
        success: false,
        mode: input.options?.mode ?? 'full',
        stats: {
          tablesProcessed: 0,
          entitiesCreated: 0,
          factsCreated: 0,
          rowsSkipped: 0,
          duration: Date.now() - startTime,
        },
        tables: [],
        errors: validation.errors,
        warnings: [],
      }
    }

    // Validate entity classes exist in ontology
    const existingClasses = new Set<string>()
    for (const term of store.graph.terms.values()) {
      if (term.kind === 'class') {
        existingClasses.add(term.id)
      }
    }

    const classErrors = validateEntityClasses(input.mapping.tables, existingClasses)
    if (classErrors.length > 0) {
      return {
        success: false,
        mode: input.options?.mode ?? 'full',
        stats: {
          tablesProcessed: 0,
          entitiesCreated: 0,
          factsCreated: 0,
          rowsSkipped: 0,
          duration: Date.now() - startTime,
        },
        tables: [],
        errors: classErrors,
        warnings: [],
      }
    }

    // Process each table
    const options = input.options ?? {}
    let totalEntities = 0
    let totalFacts = 0
    let totalSkipped = 0

    for (const mapping of input.mapping.tables) {
      const tableStart = Date.now()

      try {
        const result = await processTable(
          connector,
          mapping,
          store,
          input.mapping.globalPrefix,
          options,
          diagnostics,
        )

        tableResults.push(result)
        totalEntities += result.entitiesCreated
        totalFacts += result.factsCreated
        totalSkipped += result.errors

        if (result.errors > 0 && !options.continueOnError) {
          break
        }
      } catch (error) {
        const tableError: IngestError = {
          table: mapping.table,
          type: 'mapping',
          message: `Failed to process table: ${error instanceof Error ? error.message : String(error)}`,
          detail: error,
        }
        diagnostics.errors.push(tableError)

        tableResults.push({
          table: mapping.table,
          rowsRead: 0,
          entitiesCreated: 0,
          factsCreated: 0,
          errors: 1,
          warnings: 0,
          duration: Date.now() - tableStart,
        })

        if (!options.continueOnError) {
          break
        }
      }
    }

    // Handle dry-run mode
    if (options.mode === 'dry-run') {
      const allEntities: any[] = []
      const allFacts: any[] = []

      for (const mapping of input.mapping.tables) {
        const rows = await connector.fetchRows(mapping.table, {
          where: mapping.where,
          limit: Math.min(options.limit ?? 10, 10),
        })

        const { entities, facts } = transformRows(rows, mapping, input.mapping.globalPrefix)
        allEntities.push(...entities)
        allFacts.push(...facts)
      }

      const preview = createPreview(allEntities, allFacts)

      return {
        success: true,
        mode: 'dry-run',
        stats: {
          tablesProcessed: input.mapping.tables.length,
          entitiesCreated: 0,
          factsCreated: 0,
          rowsSkipped: 0,
          duration: Date.now() - startTime,
        },
        tables: tableResults,
        errors: diagnostics.errors,
        warnings: diagnostics.warnings,
        preview: {
          wouldCreateEntities: allEntities.length,
          wouldCreateFacts: allFacts.length,
          sampleEntities: preview.sampleEntities.map(e => ({
            id: e.id,
            classes: [...(e.classes ?? [])],
            label: e.label,
          })),
          sampleFacts: preview.sampleFacts,
        },
      }
    }

    return {
      success: diagnostics.errors.length === 0,
      mode: options.mode ?? 'full',
      stats: {
        tablesProcessed: tableResults.length,
        entitiesCreated: totalEntities,
        factsCreated: totalFacts,
        rowsSkipped: totalSkipped,
        duration: Date.now() - startTime,
      },
      tables: tableResults,
      errors: diagnostics.errors,
      warnings: diagnostics.warnings,
    }
  } catch (error) {
    diagnostics.errors.push({
      table: '',
      type: 'connection',
      message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
      detail: error,
    })

    return {
      success: false,
      mode: input.options?.mode ?? 'full',
      stats: {
        tablesProcessed: 0,
        entitiesCreated: 0,
        factsCreated: 0,
        rowsSkipped: 0,
        duration: Date.now() - startTime,
      },
      tables: tableResults,
      errors: diagnostics.errors,
      warnings: diagnostics.warnings,
    }
  } finally {
    if (connector) {
      await connector.close()
    }
  }
}

/**
 * Diagnostics a table run reports upward. Errors are capped so a systemic
 * failure (a wrong class, say) does not return one entry per row; the count
 * survives in the per-table result either way.
 */
interface Diagnostics {
  readonly warnings: IngestWarning[]
  readonly errors: IngestError[]
}

/** How many concrete per-row errors one run collects before it stops. */
const MAX_REPORTED_ERRORS = 50

/** Record one failed write, up to the cap. */
function reportWriteFailure(
  diagnostics: Diagnostics,
  mapping: TableMapping,
  ref: string,
  violations: readonly { readonly message: string }[],
): void {
  if (diagnostics.errors.length >= MAX_REPORTED_ERRORS) return
  diagnostics.errors.push({
    table: mapping.table,
    type: 'constraint',
    message: `${ref}: ${violations.map(violation => violation.message).join('; ')}`,
  })
}

/**
 * Process a single table
 */
async function processTable(
  connector: DbConnector,
  mapping: TableMapping,
  store: OntologyStore,
  globalPrefix: string | undefined,
  options: IngestOptions,
  diagnostics: Diagnostics,
): Promise<TableIngestResult> {
  const startTime = Date.now()
  let rowsRead = 0
  let entitiesCreated = 0
  let factsCreated = 0
  let errorCount = 0
  let warningCount = 0

  const batchSize = options.batchSize ?? 500
  const limit = options.limit
  let offset = 0

  while (true) {
    // Fetch batch
    const currentLimit = limit !== undefined ? Math.min(batchSize, limit - rowsRead) : batchSize
    if (currentLimit <= 0) break

    const rows = await connector.fetchRows(mapping.table, {
      where: mapping.where,
      limit: currentLimit,
      offset,
      orderBy: mapping.idColumn,
    })

    if (rows.length === 0) break

    rowsRead += rows.length

    // Transform rows
    const { entities, facts, warnings } = transformRows(rows, mapping, globalPrefix)
    warningCount += warnings.length
    diagnostics.warnings.push(...warnings)

    // Write to ontology (skip in dry-run mode)
    if (options.mode !== 'dry-run') {
      try {
        const now = new Date().toISOString()

        // Assert entities
        for (const entity of entities) {
          const result = await store.assertEntity(entity, now)
          if (result.ok) {
            entitiesCreated += 1
          } else {
            errorCount += 1
            reportWriteFailure(diagnostics, mapping, entity.id, result.violations)
            if (!options.continueOnError) {
              break
            }
          }
        }

        // Assert facts
        for (const fact of facts) {
          const result = await store.assertFact(fact, now)
          if (result.ok) {
            factsCreated += 1
          } else {
            errorCount += 1
            reportWriteFailure(
              diagnostics,
              mapping,
              `${fact.subject} ${fact.predicate} ${fact.object}`,
              result.violations,
            )
            if (!options.continueOnError) {
              break
            }
          }
        }
      } catch (error) {
        errorCount += 1
        if (diagnostics.errors.length < MAX_REPORTED_ERRORS) {
          diagnostics.errors.push({
            table: mapping.table,
            type: 'transform',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        if (!options.continueOnError) {
          break
        }
      }
    }

    offset += rows.length

    // Check if we've hit the limit
    if (limit !== undefined && rowsRead >= limit) {
      break
    }

    // Check if we got fewer rows than requested (end of table)
    if (rows.length < currentLimit) {
      break
    }
  }

  return {
    table: mapping.table,
    rowsRead,
    entitiesCreated,
    factsCreated,
    errors: errorCount,
    warnings: warningCount,
    duration: Date.now() - startTime,
  }
}
