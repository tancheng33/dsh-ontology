/**
 * Data transformation logic: database rows → ontology entities and facts
 * @module dsh-ontology/ingest/transformer
 */

import type { EntityInput, FactInput } from '../ontology.ts'
import type { TableMapping, IngestWarning } from './types.ts'
import { buildEntityId, applyTransform } from './utils.ts'

export interface TransformResult {
  entities: EntityInput[]
  facts: FactInput[]
  warnings: IngestWarning[]
}

/**
 * Transform database rows into ontology entities and facts
 */
export function transformRows(
  rows: any[],
  mapping: TableMapping,
  globalPrefix?: string,
): TransformResult {
  const entities: EntityInput[] = []
  const facts: FactInput[] = []
  const warnings: IngestWarning[] = []
  const nullFkCounts = new Map<string, number>()

  for (const row of rows) {
    try {
      const entityId = buildEntityId(row, mapping, globalPrefix)

      // Create entity
      const entity: EntityInput = {
        id: entityId,
        classes: [mapping.entityClass],
        label: mapping.labelColumn && row[mapping.labelColumn] != null
          ? String(row[mapping.labelColumn])
          : undefined,
        comment: mapping.commentColumn && row[mapping.commentColumn] != null
          ? String(row[mapping.commentColumn])
          : undefined,
      }

      entities.push(entity)

      // Transform attributes → literal facts
      if (mapping.attributes) {
        for (const attr of mapping.attributes) {
          const value = row[attr.column]
          if (value != null) {
            const transformedValue = applyTransform(String(value), attr.transform)
            facts.push({
              subject: entityId,
              predicate: attr.relation,
              object: transformedValue,
            })
          }
        }
      }

      // Transform foreign keys → entity facts
      if (mapping.foreignKeys) {
        for (const fk of mapping.foreignKeys) {
          const fkValue = row[fk.column]

          if (fkValue != null) {
            // Build target entity ID
            const targetId = buildEntityId(
              { [mapping.idColumn]: fkValue },
              { ...mapping, table: fk.targetTable },
              globalPrefix,
            )

            facts.push({
              subject: entityId,
              predicate: fk.relation,
              object: targetId,
            })
          } else if (fk.nullable !== false) {
            // Count null FKs for warning
            const key = `${fk.column} -> ${fk.targetTable}`
            nullFkCounts.set(key, (nullFkCounts.get(key) ?? 0) + 1)
          }
        }
      }
    } catch (error) {
      warnings.push({
        table: mapping.table,
        type: 'type-mismatch',
        message: `Failed to transform row: ${error instanceof Error ? error.message : String(error)}`,
        count: 1,
      })
    }
  }

  // Aggregate null FK warnings
  for (const [key, count] of nullFkCounts.entries()) {
    warnings.push({
      table: mapping.table,
      type: 'null-fk',
      message: `${count} rows have NULL foreign key: ${key}`,
      count,
    })
  }

  return { entities, facts, warnings }
}

/**
 * Create preview from a small sample of data
 */
export function createPreview(
  entities: EntityInput[],
  facts: FactInput[],
  sampleSize: number = 5,
): { sampleEntities: EntityInput[]; sampleFacts: FactInput[] } {
  return {
    sampleEntities: entities.slice(0, sampleSize),
    sampleFacts: facts.slice(0, sampleSize * 2),
  }
}
