/**
 * Database connector factory
 * @module dsh-ontology/ingest/connectors/factory
 */

import type { DbConnector } from './base.ts'
import type { ConnectionConfig } from '../types.ts'
import { PostgresConnector } from './postgres.ts'
import { MySQLConnector } from './mysql.ts'

export function createConnector(config: ConnectionConfig): DbConnector {
  switch (config.type) {
    case 'postgres':
      return new PostgresConnector(config)
    case 'mysql':
      return new MySQLConnector(config)
    default:
      throw new Error(`Unsupported database type: ${(config as any).type}`)
  }
}

export async function connectDatabase(config: ConnectionConfig): Promise<DbConnector> {
  const connector = createConnector(config)
  await connector.connect()
  return connector
}
