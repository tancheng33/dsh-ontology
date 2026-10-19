/**
 * Unit tests for data transformer
 */

import { describe, it, expect } from 'vitest'
import { transformRows, createPreview } from '../../src/ingest/transformer.js'
import type { TableMapping } from '../../src/ingest/types.js'

describe('transformRows', () => {
  it('should transform simple rows to entities', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      labelColumn: 'name',
    }

    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]

    const result = transformRows(rows, mapping)

    expect(result.entities).toHaveLength(2)
    expect(result.entities[0]).toEqual({
      id: 'users_1',
      classes: ['Person'],
      label: 'Alice',
    })
    expect(result.entities[1]).toEqual({
      id: 'users_2',
      classes: ['Person'],
      label: 'Bob',
    })
  })

  it('should transform attributes to literal facts', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      attributes: [
        { column: 'email', relation: 'has_email' },
        { column: 'status', relation: 'account_status' },
      ],
    }

    const rows = [
      { id: 1, email: 'alice@example.com', status: 'active' },
    ]

    const result = transformRows(rows, mapping)

    expect(result.facts).toHaveLength(2)
    expect(result.facts[0]!).toEqual({
      subject: 'users_1',
      predicate: 'has_email',
      object: 'alice@example.com',
    })
    expect(result.facts[1]!).toEqual({
      subject: 'users_1',
      predicate: 'account_status',
      object: 'active',
    })
  })

  it('should transform foreign keys to entity facts', () => {
    const mapping: TableMapping = {
      table: 'orders',
      entityClass: 'Order',
      idColumn: 'id',
      foreignKeys: [
        { column: 'user_id', targetTable: 'users', relation: 'placed_by' },
        { column: 'supplier_id', targetTable: 'suppliers', relation: 'supplied_by' },
      ],
    }

    const rows = [
      { id: 1001, user_id: 1, supplier_id: 101 },
    ]

    const result = transformRows(rows, mapping)

    expect(result.facts).toHaveLength(2)
    expect(result.facts[0]!).toEqual({
      subject: 'orders_1001',
      predicate: 'placed_by',
      object: 'users_1',
    })
    expect(result.facts[1]!).toEqual({
      subject: 'orders_1001',
      predicate: 'supplied_by',
      object: 'suppliers_101',
    })
  })

  it('should handle NULL foreign keys', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      foreignKeys: [
        { column: 'manager_id', targetTable: 'users', relation: 'reports_to', nullable: true },
      ],
    }

    const rows = [
      { id: 1, manager_id: null },
      { id: 2, manager_id: 1 },
    ]

    const result = transformRows(rows, mapping)

    expect(result.facts).toHaveLength(1)
    expect(result.facts[0]!.subject).toBe('users_2')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.type).toBe('null-fk')
  })

  it('should apply transformations', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      attributes: [
        { column: 'email', relation: 'has_email', transform: 'lowercase' },
        { column: 'code', relation: 'user_code', transform: 'uppercase' },
        { column: 'note', relation: 'note', transform: 'trim' },
      ],
    }

    const rows = [
      { id: 1, email: 'Alice@EXAMPLE.COM', code: 'abc123', note: '  test  ' },
    ]

    const result = transformRows(rows, mapping)

    expect(result.facts[0]!.object).toBe('alice@example.com')
    expect(result.facts[1]!.object).toBe('ABC123')
    expect(result.facts[2]!.object).toBe('test')
  })

  it('should use global prefix', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
    }

    const rows = [{ id: 1 }]
    const result = transformRows(rows, mapping, 'prod')

    expect(result.entities[0]!.id).toBe('prod_users_1')
  })

  it('should use custom entity ID template', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      entityIdTemplate: 'user_${id}_v2',
    }

    const rows = [{ id: 123 }]
    const result = transformRows(rows, mapping)

    expect(result.entities[0]!.id).toBe('user_123_v2')
  })
})

describe('createPreview', () => {
  it('should limit sample size', () => {
    const entities = Array.from({ length: 100 }, (_, i) => ({
      id: `entity_${i}`,
      classes: ['Test'],
    }))

    const facts = Array.from({ length: 100 }, (_, i) => ({
      subject: `entity_${i}`,
      predicate: 'rel',
      object: `target_${i}`,
    }))

    const preview = createPreview(entities, facts, 3)

    expect(preview.sampleEntities).toHaveLength(3)
    expect(preview.sampleFacts).toHaveLength(6)
  })
})
