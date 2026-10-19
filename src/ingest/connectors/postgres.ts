/**
 * PostgreSQL database connector
 * @module dsh-ontology/ingest/connectors/postgres
 */

import type { Client, ClientConfig } from 'pg'
import type { DbConnector } from './base.ts'
import type { ColumnInfo, ConnectionConfig } from '../types.ts'

/** What a driver module is loaded through. */
type PgModule = typeof import('pg')

/**
 * Load `pg` on demand.
 *
 * It is an optional peer dependency, and this plugin is imported by every
 * profile that lists it — so a static import would make a PostgreSQL driver
 * mandatory for someone who only ever wanted the core tools. Loading it at
 * connect time keeps the dependency honest: absent until the tool is used,
 * and reported as an install instruction rather than a boot crash.
 * @returns the driver module.
 */
async function loadDriver(): Promise<PgModule> {
  try {
    return await import('pg')
  } catch (cause) {
    throw new Error(
      'The PostgreSQL driver is not installed. Add it with `pnpm add pg` '
      + 'to use ontology_ingest_db against PostgreSQL.',
      { cause },
    )
  }
}

export class PostgresConnector implements DbConnector {
  #client: Client | null = null

  constructor(private config: ConnectionConfig) {
    if (config.type !== 'postgres') {
      throw new Error(`Invalid config type: expected 'postgres', got '${config.type}'`)
    }
  }

  async connect(): Promise<void> {
    const pg = await loadDriver()
    // `pg` is CJS: Node hoists its named exports onto the namespace, but fall
    // back to the module object if a future interop stops doing so.
    const PgClient = pg.Client
      ?? (pg as unknown as { default?: PgModule }).default?.Client
    if (PgClient === undefined) {
      throw new Error('the `pg` package did not export Client')
    }

    const options: ClientConfig = {
      host: this.config.host,
      port: this.config.port ?? 5432,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl,
      connectionTimeoutMillis: this.config.connectionTimeout ?? 10000,
    }

    this.#client = new PgClient(options)
    await this.#client.connect()
  }

  async close(): Promise<void> {
    const client = this.#client
    this.#client = null
    if (client !== null) await client.end()
  }

  async #query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const client = this.#client
    if (client === null) throw new Error('not connected')
    const result = await client.query(sql, params as never)
    return result.rows as T[]
  }

  async getTables(): Promise<string[]> {
    const rows = await this.#query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)
    return rows.map(row => row.table_name)
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    // One round trip: the primary-key flag is a correlated EXISTS rather than
    // a second catalog query.
    const rows = await this.#query<{ column_name: string, is_primary_key: boolean }>(`
      SELECT
        c.column_name,
        EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.table_schema = 'public'
            AND tc.table_name = c.table_name
            AND tc.constraint_type = 'PRIMARY KEY'
            AND kcu.column_name = c.column_name
        ) AS is_primary_key
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = $1
      ORDER BY c.ordinal_position
    `, [table])

    return rows.map(row => ({ name: row.column_name, isPrimaryKey: row.is_primary_key }))
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
