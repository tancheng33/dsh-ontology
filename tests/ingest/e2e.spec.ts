/**
 * End-to-end tests against real PostgreSQL and MySQL servers.
 *
 * They skip themselves when the servers are not reachable, so a plain
 * `pnpm test` stays hermetic on a machine without them. To run them:
 *
 *   docker run -d --name dsh-pg-test    -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=business    -p 55432:5432 postgres:16-alpine
 *   docker run -d --name dsh-mysql-test -e MYSQL_ROOT_PASSWORD=testpass \
 *     -e MYSQL_DATABASE=business -p 33306:3306 mysql:8
 *
 * load `schema.sql` / `schema-mysql.sql` into each, then `pnpm test`.
 * @module dsh-ontology/tests/ingest/e2e
 */

import { describe, it, expect } from 'vitest'
import { memoryDomain } from '../memory-domain.ts'
import { OntologyStore } from '../../src/store.ts'
import { ingestFromDatabase } from '../../src/ingest/engine.ts'
import { queryEntities, queryFacts, findPath } from '../../src/ontology.ts'
import type { RelationInput } from '../../src/ontology.ts'
import type { IngestDbInput, ConnectionConfig } from '../../src/ingest/types.ts'

const PG: ConnectionConfig = {
  type: 'postgres',
  host: '127.0.0.1',
  port: 55432,
  database: 'business',
  user: 'postgres',
  password: 'testpass',
}

const MYSQL: ConnectionConfig = {
  type: 'mysql',
  host: '127.0.0.1',
  port: 33306,
  database: 'business',
  user: 'root',
  password: 'testpass',
}

/** The mapping both dialects share — foreign keys drive the relations. */
const TABLES: IngestDbInput['mapping']['tables'] = [
  {
    table: 'teams',
    entityClass: 'Team',
    idColumn: 'id',
    labelColumn: 'name',
    attributes: [{ column: 'region', relation: 'region' }],
    where: 'deleted_at IS NULL',
  },
  {
    table: 'suppliers',
    entityClass: 'Supplier',
    idColumn: 'id',
    labelColumn: 'company_name',
    attributes: [
      { column: 'contact_email', relation: 'contact_email' },
      { column: 'country', relation: 'country_code', transform: 'uppercase' },
    ],
  },
  {
    table: 'users',
    entityClass: 'Person',
    idColumn: 'id',
    labelColumn: 'full_name',
    commentColumn: 'bio',
    attributes: [
      { column: 'email', relation: 'has_email', transform: 'lowercase' },
      { column: 'phone', relation: 'has_phone', transform: 'trim' },
      { column: 'status', relation: 'account_status' },
    ],
    foreignKeys: [
      { column: 'team_id', targetTable: 'teams', relation: 'member_of', nullable: true },
      { column: 'manager_id', targetTable: 'users', relation: 'reports_to', nullable: true },
    ],
  },
  {
    table: 'orders',
    entityClass: 'Order',
    idColumn: 'id',
    labelColumn: 'order_no',
    attributes: [
      { column: 'amount', relation: 'order_amount' },
      { column: 'status', relation: 'order_status' },
    ],
    foreignKeys: [
      { column: 'user_id', targetTable: 'users', relation: 'placed_by', nullable: false },
      { column: 'supplier_id', targetTable: 'suppliers', relation: 'supplied_by', nullable: false },
    ],
  },
]

const MAPPING: IngestDbInput['mapping'] = { tables: TABLES }

/** The vocabulary the mapping asserts into. */
const CLASSES = ['Team', 'Supplier', 'Person', 'Order']

/**
 * Inverses are declared second: `inverseOf` requires its target to exist.
 * Only one side of a pair carries `inverseOf` (the README's convention).
 */
const RELATIONS: RelationInput[] = [
  { id: 'member_of', domain: ['Person'], range: ['Team'] },
  { id: 'reports_to', domain: ['Person'], range: ['Person'], characteristics: ['transitive'] },

  { id: 'placed', domain: ['Person'], range: ['Order'] },
  { id: 'placed_by', domain: ['Order'], range: ['Person'], inverseOf: 'placed' },

  { id: 'supplies', domain: ['Supplier'], range: ['Order'] },
  { id: 'supplied_by', domain: ['Order'], range: ['Supplier'], inverseOf: 'supplies' },

  { id: 'region', domain: ['Team'], rangeKind: 'literal' },
  { id: 'contact_email', domain: ['Supplier'], rangeKind: 'literal' },
  { id: 'country_code', domain: ['Supplier'], rangeKind: 'literal' },
  { id: 'has_email', domain: ['Person'], rangeKind: 'literal' },
  { id: 'has_phone', domain: ['Person'], rangeKind: 'literal' },
  { id: 'account_status', domain: ['Person'], rangeKind: 'literal' },
  { id: 'order_amount', domain: ['Order'], rangeKind: 'literal' },
  { id: 'order_status', domain: ['Order'], rangeKind: 'literal' },
]

const NOW = '2026-10-16T00:00:00.000Z'

/** A fresh store with the vocabulary declared. */
async function freshStore(): Promise<OntologyStore> {
  const store = new OntologyStore(memoryDomain(), {
    strict: true,
    maxEntities: 1000,
    maxFacts: 10000,
  })
  for (const id of CLASSES) {
    const result = await store.defineClass({ id }, NOW)
    expect(result.ok, `defineClass ${id}: ${JSON.stringify(result.violations)}`).toBe(true)
  }
  for (const relation of RELATIONS) {
    const result = await store.defineRelation(relation, NOW)
    expect(result.ok, `defineRelation ${relation.id}: ${JSON.stringify(result.violations)}`).toBe(true)
  }
  return store
}

/** Whether a server answers; a connection error means it is not up. */
async function reachable(connection: ConnectionConfig): Promise<boolean> {
  const result = await ingestFromDatabase(
    {
      // Short timeout: a plain `pnpm test` on a machine without these servers
      // should skip in a moment, not stall for the default ten seconds.
      connection: { ...connection, connectionTimeout: 1500 },
      mapping: { tables: [] },
      options: { mode: 'dry-run' },
    },
    new OntologyStore(memoryDomain(), { strict: true, maxEntities: 10, maxFacts: 10 }),
  )
  return !result.errors.some(error => error.type === 'connection')
}

const [pgUp, mysqlUp] = await Promise.all([reachable(PG), reachable(MYSQL)])

function label(store: OntologyStore, id: string): string | undefined {
  return store.graph.entities.get(id)?.label
}

function objects(store: OntologyStore, subject: string, predicate: string, inferred = false): string[] {
  return queryFacts(store.graph, { subject, predicate, includeInferred: inferred })
    .map(fact => fact.object)
    .sort()
}

describe.skipIf(!pgUp || !mysqlUp).each([
  ['PostgreSQL', PG],
  ['MySQL', MYSQL],
] as const)('database ingestion end to end (%s)', (_name, connection) => {
  /** Freshly ingested store, built once per dialect. */
  const loaded = (async () => {
    const store = await freshStore()
    return { store, result: await ingestFromDatabase({ connection, mapping: MAPPING }, store) }
  })()

  it('ingests every mapped table without errors', async () => {
    const { result } = await loaded

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)

    const created = (table: string) =>
      result.tables.find(entry => entry.table === table)?.entitiesCreated

    expect(created('teams')).toBe(2)
    expect(created('suppliers')).toBe(3)
    expect(created('users')).toBe(4)
    expect(created('orders')).toBe(5)
    expect(result.stats.entitiesCreated).toBe(14)
  })

  it('builds entities from rows, with labels and comments', async () => {
    const { store } = await loaded

    const zhangsan = store.graph.entities.get('users_1')
    expect(zhangsan?.classes).toContain('Person')
    expect(zhangsan?.label).toBe('张三')
    expect(zhangsan?.comment).toBe('平台组负责人')

    expect(label(store, 'suppliers_101')).toBe('阿里云')
    expect(label(store, 'orders_1001')).toBe('ORD-2026-001')
  })

  it('honours the per-table WHERE clause', async () => {
    const { store } = await loaded

    // Team 3 is soft-deleted; `deleted_at IS NULL` must exclude it.
    expect(store.graph.entities.get('teams_3')).toBeUndefined()
    expect(label(store, 'teams_1')).toBe('Platform')
  })

  it('turns foreign keys into entity-valued relations', async () => {
    const { store } = await loaded

    expect(objects(store, 'orders_1001', 'placed_by')).toEqual(['users_1'])
    expect(objects(store, 'orders_1001', 'supplied_by')).toEqual(['suppliers_101'])
    expect(objects(store, 'users_2', 'member_of')).toEqual(['teams_1'])
    expect(objects(store, 'users_2', 'reports_to')).toEqual(['users_1'])
  })

  it('turns columns into literal relations, applying transforms', async () => {
    const { store } = await loaded

    // lowercase over a mixed-case source value
    expect(objects(store, 'users_1', 'has_email')).toEqual(['zhangsan@example.com'])
    // trim over a padded source value
    expect(objects(store, 'users_1', 'has_phone')).toEqual(['138-0000-0001'])
    expect(objects(store, 'orders_1001', 'order_amount')).toEqual(['5000.00'])
    expect(objects(store, 'suppliers_103', 'country_code')).toEqual(['US'])
  })

  it('skips NULL literals rather than storing empty facts', async () => {
    const { store } = await loaded

    // 赵六 has no phone; 李四 has no bio.
    expect(objects(store, 'users_4', 'has_phone')).toEqual([])
    expect(store.graph.entities.get('users_2')?.comment).toBeUndefined()
  })

  it('reports NULL foreign keys as warnings, not errors', async () => {
    const { result } = await loaded

    // 张三 has no manager; that is expected, so it must not be an error.
    expect(result.errors).toEqual([])
    expect(result.warnings.some(warning => warning.type === 'null-fk')).toBe(true)
  })

  it('is idempotent when re-imported', async () => {
    const { store } = await loaded
    const before = store.graph.facts.size

    await ingestFromDatabase({ connection, mapping: MAPPING }, store)

    expect(store.graph.facts.size).toBe(before)
  })

  it('entails the inverse of a foreign key edge', async () => {
    const { store } = await loaded

    // The database only stores orders.user_id — `placed` appears nowhere in it.
    expect(objects(store, 'users_1', 'placed')).toEqual([])

    const inferred = queryFacts(store.graph, {
      subject: 'users_1',
      predicate: 'placed',
      includeInferred: true,
    })
    expect(inferred.map(fact => fact.object).sort()).toEqual([
      'orders_1001',
      'orders_1002',
      'orders_1003',
    ])
    expect(inferred.every(fact => fact.via === 'inverse')).toBe(true)
  })

  it('entails the transitive closure of a self-referencing foreign key', async () => {
    const { store } = await loaded

    // 赵六 → 李四 → 张三; only the first hop is in the source data.
    expect(objects(store, 'users_4', 'reports_to')).toEqual(['users_2'])

    const inferred = queryFacts(store.graph, {
      subject: 'users_4',
      predicate: 'reports_to',
      includeInferred: true,
    })
    expect(inferred.map(fact => fact.object).sort()).toEqual(['users_1', 'users_2'])
    expect(inferred.find(fact => fact.object === 'users_1')?.via).toBe('transitive')
  })

  it('answers "张三的订单是什么，供应商是谁" by search, then traversal', async () => {
    const { store } = await loaded

    // 1. Resolve the natural-language name to an entity.
    const people = queryEntities(store.graph, { classId: 'Person', search: '张三' })
    expect(people.map(person => person.id)).toEqual(['users_1'])
    const zhangsan = people[0]!.id

    // 2. His orders, via the entailed inverse of the foreign key.
    const orderIds = queryFacts(store.graph, {
      subject: zhangsan,
      predicate: 'placed',
      includeInferred: true,
    }).map(fact => fact.object).sort()
    expect(orderIds).toEqual(['orders_1001', 'orders_1002', 'orders_1003'])

    // 3. Each order's supplier, read straight off the foreign key.
    const supplierIds = orderIds.map(orderId => {
      const fact = queryFacts(store.graph, { subject: orderId, predicate: 'supplied_by' })[0]
      return fact!.object
    }).sort()

    // Sorted on the ASCII ids, then read out as labels, so the assertion does
    // not depend on the runtime's collation for the Chinese names.
    expect(supplierIds).toEqual(['suppliers_101', 'suppliers_102', 'suppliers_103'])
    expect(supplierIds.map(id => label(store, id))).toEqual(['阿里云', '腾讯云', 'AWS'])
  })

  it('finds a two-hop path from a person to a supplier', async () => {
    const { store } = await loaded

    const path = findPath(store.graph, 'users_1', 'suppliers_101', 4, true)
    expect(path).toHaveLength(2)
    expect(path![0]!.subject).toBe('users_1')
    expect(path![1]!.object).toBe('suppliers_101')
  })

  it('answers a class query for every subclass member', async () => {
    const { store } = await loaded

    expect(queryEntities(store.graph, { classId: 'Order' })).toHaveLength(5)
    expect(queryEntities(store.graph, { classId: 'Supplier' })).toHaveLength(3)
    expect(queryEntities(store.graph, { classId: 'Person' })).toHaveLength(4)
  })
})

describe.skipIf(!pgUp)('ingestion options (PostgreSQL)', () => {
  it('previews a dry run without writing', async () => {
    const store = await freshStore()
    const before = store.graph.entities.size

    const result = await ingestFromDatabase(
      { connection: PG, mapping: MAPPING, options: { mode: 'dry-run', limit: 2 } },
      store,
    )

    expect(result.mode).toBe('dry-run')
    expect(result.preview!.sampleEntities.length).toBeGreaterThan(0)
    expect(result.preview!.sampleFacts.length).toBeGreaterThan(0)
    expect(store.graph.entities.size).toBe(before)
  })

  it('applies a global entity prefix', async () => {
    const store = await freshStore()

    await ingestFromDatabase(
      { connection: PG, mapping: { tables: TABLES, globalPrefix: 'prod' } },
      store,
    )

    expect(label(store, 'prod_users_1')).toBe('张三')
    expect(store.graph.entities.get('prod_orders_1001')?.classes).toContain('Order')
  })

  it('stops at the row limit', async () => {
    const store = await freshStore()

    const result = await ingestFromDatabase(
      { connection: PG, mapping: { tables: [TABLES[3]!] }, options: { limit: 2 } },
      store,
    )

    expect(result.tables[0]!.entitiesCreated).toBe(2)
  })

  it('refuses to ingest into an empty ontology', async () => {
    const empty = new OntologyStore(memoryDomain(), {
      strict: true,
      maxEntities: 1000,
      maxFacts: 10000,
    })

    const result = await ingestFromDatabase({ connection: PG, mapping: MAPPING }, empty)

    expect(result.success).toBe(false)
    expect(result.errors.some(error => error.type === 'validation')).toBe(true)
    expect(result.stats.entitiesCreated).toBe(0)
  })

  it('reports an unknown table as a validation error', async () => {
    const store = await freshStore()

    const result = await ingestFromDatabase(
      { connection: PG, mapping: { tables: [{ table: 'not_a_table', entityClass: 'Person', idColumn: 'id' }] } },
      store,
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]!.message).toContain('not_a_table')
  })

  it('reports a bad password as a connection error, not a crash', async () => {
    const store = await freshStore()

    const result = await ingestFromDatabase(
      { connection: { ...PG, password: 'wrong' }, mapping: MAPPING },
      store,
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]!.type).toBe('connection')
  })
})
