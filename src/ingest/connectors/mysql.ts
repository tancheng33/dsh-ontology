/**
 * MySQL database connector
 * @module dsh-ontology/ingest/connectors/mysql
 */

import type { Connection } from 'mysql2/promise'
import type { DbConnector } from './base.ts'
import type { ColumnInfo, ConnectionConfig } from '../types.ts'

/** What a driver module is loaded through. */
type MysqlModule = typeof import('mysql2/promise')

/**
 * Load `mysql2` on demand.
 *
 * It is an optional peer dependency, so it must not be pulled in by a plugin
 * that every profile imports. See the PostgreSQL connector for the reasoning.
 * @returns the driver module.
 */
async function loadDriver(): Promise<MysqlModule> {
  try {
    return await import('mysql2/promise')
  } catch (cause) {
    throw new Error(
      'The MySQL driver is not installed. Add it with `pnpm add mysql2` '
      + 'to use ontology_ingest_db against MySQL.',
      { cause },
    )
  }
}

export class MySQLConnector implements DbConnector {
  #connection: Connection | null = null

  constructor(private config: ConnectionConfig) {
    if (config.type !== 'mysql') {
      throw new Error(`Invalid config type: expected 'mysql', got '${config.type}'`)
    }
  }

  async connect(): Promise<void> {
    const mysql = await loadDriver()
    // See the PostgreSQL connector: prefer the hoisted named export, fall
    // back to the module object.
    const createConnection = mysql.createConnection
      ?? (mysql as unknown as { default?: MysqlModule }).default?.createConnection
    if (createConnection === undefined) {
      throw new Error('the `mysql2/promise` package did not export createConnection')
    }

    this.#connection = await createConnection({
      host: this.config.host,
      port: this.config.port ?? 3306,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl === true ? {} : (this.config.ssl || undefined),
      connectTimeout: this.config.connectionTimeout ?? 10000,
      // A server whose defaults are latin1 would otherwise mangle non-ASCII
      // labels on the way in, with no error.
      charset: 'utf8mb4',
    })
  }

  async close(): Promise<void> {
    const connection = this.#connection
    this.#connection = null
    if (connection !== null) await connection.end()
  }

  async #query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const connection = this.#connection
    if (connection === null) throw new Error('not connected')
    const [rows] = await connection.execute(sql, params as never)
    return rows as T[]
  }

  async getTables(): Promise<string[]> {
    const rows = await this.#query<{ TABLE_NAME: string }>(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `)
    return rows.map(row => row.TABLE_NAME)
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    // MySQL marks a primary-key column in COLUMN_KEY, so this is one query.
    const rows = await this.#query<{ COLUMN_NAME: string, COLUMN_KEY: string }>(`
      SELECT COLUMN_NAME, COLUMN_KEY
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [table])

    return rows.map(row => ({
      name: row.COLUMN_NAME,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
    }))
  }

  async fetchRows(table: string, options: {
    where?: string
    limit?: number
    offset?: number
    orderBy?: string
  }): Promise<any[]> {
    const parts = [`SELECT * FROM ${table}`]

    if (options.where !== undefined) parts.push(`WHERE ${options.where}`)
    if (options.orderBy !== undefined) parts.push(`ORDER BY ${options.orderBy}`)
    if (options.limit !== undefined) parts.push(`LIMIT ${options.limit}`)
    if (options.offset !== undefined) parts.push(`OFFSET ${options.offset}`)

    return this.#query(parts.join(' '))
  }
}
