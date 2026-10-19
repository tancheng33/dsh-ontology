/**
 * Utility functions for database ingestion
 * @module dsh-ontology/ingest/utils
 */

import type { AttributeMapping, TableMapping } from './types.ts'

/**
 * Build entity ID from row data and mapping configuration
 */
export function buildEntityId(
  row: Record<string, any>,
  mapping: TableMapping,
  globalPrefix?: string,
): string {
  const idValue = row[mapping.idColumn]

  if (idValue == null) {
    throw new Error(`Missing primary key value for column '${mapping.idColumn}'`)
  }

  // Custom template
  if (mapping.entityIdTemplate) {
    return mapping.entityIdTemplate
      .replace(/\$\{table\}/g, mapping.table)
      .replace(/\$\{id\}/g, String(idValue))
      .replace(/\$\{prefix\}/g, globalPrefix ?? '')
  }

  // Default format
  const base = `${mapping.table}_${idValue}`
  return globalPrefix ? `${globalPrefix}_${base}` : base
}

/**
 * Apply transformation to a string value
 */
export function applyTransform(
  value: string,
  transform?: AttributeMapping['transform'],
): string {
  if (!transform) return value

  switch (transform) {
    case 'lowercase':
      return value.toLowerCase()
    case 'uppercase':
      return value.toUpperCase()
    case 'trim':
      return value.trim()
    default:
      return value
  }
}

/**
 * Resolve environment variables in a string
 * Example: "${DB_PASSWORD}" -> actual password from process.env
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not defined`)
    }
    return envValue
  })
}

/**
 * Check if a value looks like it contains an environment variable reference
 */
export function hasEnvVar(value: string): boolean {
  return /\$\{[^}]+\}/.test(value)
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60000).toFixed(2)}min`
}
