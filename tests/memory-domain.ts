/**
 * An in-memory stand-in for one open storage domain, satisfying the parts of
 * the `Domain` contract the store uses. It lets the store and the tools be
 * tested end to end — real validation, real entailment, real tool results —
 * without a backend, a medium, or a Cordis context.
 * @module dsh-ontology/tests/memory-domain
 */

import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { OntologyDomainSpec } from '../src/spec.ts'

/** A table backed by a plain `Map`, with the contract's async write surface. */
class MemoryTable<V> implements KvTable<string, V> {
  readonly #records = new Map<string, V>()

  get(key: string): V | undefined {
    return this.#records.get(key)
  }

  entries(): IterableIterator<[string, V]> {
    return [...this.#records.entries()][Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    return [...this.#records.keys()][Symbol.iterator]()
  }

  get size(): number {
    return this.#records.size
  }

  async put(key: string, value: V): Promise<void> {
    this.#records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.#records.delete(key)
  }

  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.#records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.#records.set(key, next)
    return next
  }
}

/**
 * Build an in-memory ontology domain.
 * @param name - Domain name reported by the handle.
 * @returns the domain handle.
 */
export function memoryDomain(name = 'ontology'): Domain<OntologyDomainSpec> {
  const tables = new Map<string, MemoryTable<unknown>>([
    ['terms', new MemoryTable()],
    ['entities', new MemoryTable()],
    ['facts', new MemoryTable()],
  ])
  return {
    name,
    global: undefined as never,
    table: (table: string) => {
      const found = tables.get(table)
      if (found === undefined) throw new Error(`unknown table ${table}`)
      return found
    },
    close: async () => {},
  } as unknown as Domain<OntologyDomainSpec>
}
