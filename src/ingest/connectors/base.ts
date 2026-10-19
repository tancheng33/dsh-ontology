/**
 * Abstract database connector interface
 * @module dsh-ontology/ingest/connectors/base
 */

import type { ColumnInfo } from '../types.ts'

/**
 * What the ingestion engine needs from a database.
 *
 * Deliberately narrow: enough to check that a mapping names real tables and
 * columns, and to read rows. Nothing here exposes foreign-key metadata, because
 * the mapping states which columns are foreign keys and what they mean — the
 * schema is not consulted to guess that.
 */
export interface DbConnector {
  /** Open the connection. */
  connect(): Promise<void>

  /** Close it. Safe to call more than once. */
  close(): Promise<void>

  /** Every base table in the connected database. */
  getTables(): Promise<string[]>

  /** The columns of one table, in declaration order. */
  getColumns(table: string): Promise<ColumnInfo[]>

  /**
   * Read rows, optionally filtered, ordered, and windowed.
   * @param table - Table to read.
   * @param options - The filter and window to apply.
   */
  fetchRows(table: string, options: {
    where?: string
    limit?: number
    offset?: number
    orderBy?: string
  }): Promise<any[]>
}
