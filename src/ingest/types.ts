/**
 * Database ingestion types - isolated from core ontology types
 * @module dsh-ontology/ingest/types
 */

// ============ Input Types ============

export interface ConnectionConfig {
  type: 'mysql' | 'postgres'
  host: string
  port?: number
  database: string
  user: string
  password: string
  ssl?: boolean | { rejectUnauthorized: boolean }
  connectionTimeout?: number
}

export interface AttributeMapping {
  column: string
  relation: string
  transform?: 'lowercase' | 'uppercase' | 'trim'
}

export interface ForeignKeyMapping {
  column: string
  targetTable: string
  relation: string
  nullable?: boolean
}

export interface TableMapping {
  table: string
  entityClass: string
  idColumn: string
  labelColumn?: string
  commentColumn?: string
  attributes?: AttributeMapping[]
  foreignKeys?: ForeignKeyMapping[]
  where?: string
  entityIdTemplate?: string
}

export interface MappingConfig {
  tables: TableMapping[]
  globalPrefix?: string
}

export interface IngestOptions {
  mode?: 'full' | 'incremental' | 'dry-run'
  batchSize?: number
  limit?: number
  timestampColumn?: string
  lastSyncTime?: string
  continueOnError?: boolean
}

export interface IngestDbInput {
  connection: ConnectionConfig
  mapping: MappingConfig
  options?: IngestOptions
}

// ============ Output Types ============

export interface TableIngestResult {
  table: string
  rowsRead: number
  entitiesCreated: number
  factsCreated: number
  errors: number
  warnings: number
  duration: number
}

export interface IngestError {
  table: string
  row?: number
  type: 'connection' | 'validation' | 'constraint' | 'mapping' | 'transform'
  message: string
  detail?: unknown
}

export interface IngestWarning {
  table: string
  type: 'null-fk' | 'missing-label' | 'duplicate-id' | 'type-mismatch'
  message: string
  count?: number
  examples?: string[]
}

export interface IngestStats {
  tablesProcessed: number
  entitiesCreated: number
  factsCreated: number
  rowsSkipped: number
  duration: number
}

export interface IngestPreview {
  wouldCreateEntities: number
  wouldCreateFacts: number
  sampleEntities: Array<{ id: string; classes: string[]; label?: string }>
  sampleFacts: Array<{ subject: string; predicate: string; object: string }>
}

export interface IngestDbOutput {
  success: boolean
  mode: 'full' | 'incremental' | 'dry-run'
  stats: IngestStats
  tables: TableIngestResult[]
  errors: IngestError[]
  warnings: IngestWarning[]
  preview?: IngestPreview
}

// ============ Internal Types ============

/** One column of a table, as far as mapping validation needs to know. */
export interface ColumnInfo {
  name: string
  isPrimaryKey: boolean
}
