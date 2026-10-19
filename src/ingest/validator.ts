/**
 * Validation of a mapping against the live schema, and of its classes against
 * the declared vocabulary. Both run before a single row is read, so a mapping
 * that cannot work fails with a sentence rather than a partial import.
 * @module dsh-ontology/ingest/validator
 */

import type { DbConnector } from './connectors/base.ts'
import type { MappingConfig, TableMapping, IngestError } from './types.ts'

export interface ValidationResult {
  valid: boolean
  errors: IngestError[]
}

/**
 * Check that a mapping names tables and columns that exist.
 *
 * Note what this does not do: it does not verify that a column mapped as a
 * foreign key is declared as one in the schema. The mapping is the statement
 * of intent, and a column that holds a key to another table is the caller's
 * claim to make — the ontology's own domain/range check is what catches a
 * relation asserted between the wrong kinds of thing.
 * @param connector - An open connection to the source database.
 * @param config - The mapping to check.
 * @returns whether it is usable, with every problem found.
 */
export async function validateMapping(
  connector: DbConnector,
  config: MappingConfig,
): Promise<ValidationResult> {
  const errors: IngestError[] = []

  const tables = new Set(await connector.getTables())

  for (const mapping of config.tables) {
    const fail = (message: string) =>
      errors.push({ table: mapping.table, type: 'validation', message })

    if (!tables.has(mapping.table)) {
      fail(`table '${mapping.table}' does not exist`)
      continue
    }

    let columns: Set<string>
    let primaryKeys: Set<string>
    try {
      const info = await connector.getColumns(mapping.table)
      columns = new Set(info.map(column => column.name))
      primaryKeys = new Set(info.filter(column => column.isPrimaryKey).map(column => column.name))
    } catch (error) {
      fail(`could not read the columns of '${mapping.table}': ${describe(error)}`)
      continue
    }

    if (!columns.has(mapping.idColumn)) {
      fail(`id column '${mapping.idColumn}' does not exist in table '${mapping.table}'`)
    } else if (!primaryKeys.has(mapping.idColumn)) {
      fail(`id column '${mapping.idColumn}' is not the primary key of table '${mapping.table}'`)
    }

    for (const [role, column] of [
      ['label', mapping.labelColumn],
      ['comment', mapping.commentColumn],
    ] as const) {
      if (column !== undefined && !columns.has(column)) {
        fail(`${role} column '${column}' does not exist in table '${mapping.table}'`)
      }
    }

    for (const attribute of mapping.attributes ?? []) {
      if (!columns.has(attribute.column)) {
        fail(`attribute column '${attribute.column}' does not exist in table '${mapping.table}'`)
      }
    }

    for (const foreignKey of mapping.foreignKeys ?? []) {
      if (!columns.has(foreignKey.column)) {
        fail(`foreign key column '${foreignKey.column}' does not exist in table '${mapping.table}'`)
      }
      if (!tables.has(foreignKey.targetTable)) {
        fail(`foreign key target table '${foreignKey.targetTable}' does not exist`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Check that every class a mapping imports into has been declared.
 *
 * The store would reject each row for this anyway, once per row; catching it
 * here turns thousands of identical errors into one sentence.
 * @param mappings - The tables about to be imported.
 * @param declared - Class ids present in the vocabulary.
 * @returns one error per unknown class.
 */
export function validateEntityClasses(
  mappings: readonly TableMapping[],
  declared: ReadonlySet<string>,
): IngestError[] {
  const errors: IngestError[] = []
  for (const mapping of mappings) {
    if (!declared.has(mapping.entityClass)) {
      errors.push({
        table: mapping.table,
        type: 'validation',
        message: `entity class '${mapping.entityClass}' is not defined in the ontology; `
          + 'declare it with ontology_define first',
      })
    }
  }
  return errors
}

/** Render an unknown thrown value as a message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
