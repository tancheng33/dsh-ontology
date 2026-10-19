/**
 * Unit tests for utilities
 */

import { describe, it, expect } from 'vitest'
import {
  buildEntityId,
  applyTransform,
  resolveEnvVars,
  hasEnvVar,
  formatDuration,
} from '../../src/ingest/utils.js'
import type { TableMapping } from '../../src/ingest/types.js'

describe('buildEntityId', () => {
  it('should build default entity ID', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
    }

    const row = { id: 123 }
    const id = buildEntityId(row, mapping)

    expect(id).toBe('users_123')
  })

  it('should apply global prefix', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
    }

    const row = { id: 123 }
    const id = buildEntityId(row, mapping, 'prod')

    expect(id).toBe('prod_users_123')
  })

  it('should use custom template', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
      entityIdTemplate: 'user_${id}_v2',
    }

    const row = { id: 123 }
    const id = buildEntityId(row, mapping)

    expect(id).toBe('user_123_v2')
  })

  it('should throw on missing ID', () => {
    const mapping: TableMapping = {
      table: 'users',
      entityClass: 'Person',
      idColumn: 'id',
    }

    const row = {}

    expect(() => buildEntityId(row, mapping)).toThrow('Missing primary key')
  })
})

describe('applyTransform', () => {
  it('should lowercase', () => {
    expect(applyTransform('HELLO', 'lowercase')).toBe('hello')
  })

  it('should uppercase', () => {
    expect(applyTransform('hello', 'uppercase')).toBe('HELLO')
  })

  it('should trim', () => {
    expect(applyTransform('  hello  ', 'trim')).toBe('hello')
  })

  it('should return as-is without transform', () => {
    expect(applyTransform('hello', undefined)).toBe('hello')
  })
})

describe('resolveEnvVars', () => {
  it('should resolve environment variables', () => {
    process.env.TEST_VAR = 'secret123'
    const result = resolveEnvVars('password=${TEST_VAR}')
    expect(result).toBe('password=secret123')
  })

  it('should throw on undefined variable', () => {
    expect(() => resolveEnvVars('${NONEXISTENT}')).toThrow('not defined')
  })
})

describe('hasEnvVar', () => {
  it('should detect environment variable syntax', () => {
    expect(hasEnvVar('${DB_PASSWORD}')).toBe(true)
    expect(hasEnvVar('plain text')).toBe(false)
  })
})

describe('formatDuration', () => {
  it('should format milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('should format seconds', () => {
    expect(formatDuration(2500)).toBe('2.50s')
  })

  it('should format minutes', () => {
    expect(formatDuration(65000)).toBe('1.08min')
  })
})
