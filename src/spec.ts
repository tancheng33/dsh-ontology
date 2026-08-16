/**
 * The durable declaration of the ontology domain: one zod schema per stored
 * record and the `defineDomain` spec the storage facility opens. Records are
 * validated against these schemas at open time, so a hand-edited or
 * partially-written medium fails loudly instead of poisoning the graph.
 * @module dsh-ontology/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Entity, Fact, Term } from './types.ts'

/** Bumped whenever a stored shape changes incompatibly. */
export const ONTOLOGY_DOMAIN_VERSION = 1

/**
 * Domain-name syntax the storage layer accepts — the name doubles as a backend
 * unit name, so it must be safe as both a file name and a SQL identifier.
 */
export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * Validate a configured domain name at the plugin's own boundary.
 *
 * The storage layer rejects a bad name too, but only from inside `defineDomain`
 * during plugin load, where the failure surfaces as a loader stack trace naming
 * neither the offending setting nor the file it came from.
 * @param name - The configured domain name.
 * @returns the name, unchanged.
 * @throws TypeError when the name is not a legal domain name.
 */
export function assertDomainName(name: string): string {
  if (!DOMAIN_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `dsh-ontology: invalid "domain" setting ${JSON.stringify(name)} — a domain name must start `
      + 'with a lowercase letter and contain only lowercase letters, digits, and underscores '
      + '(e.g. "ontology", "team_ontology"). Fix it in the plugin row config.',
    )
  }
  return name
}

const rangeKind = z.enum(['entity', 'literal'])
const characteristic = z.enum(['transitive', 'symmetric', 'functional'])

/** Durable shape of one class term. */
export const classTermSchema = z.object({
  kind: z.literal('class'),
  id: z.string(),
  label: z.string().optional(),
  comment: z.string().optional(),
  subClassOf: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of one relation term. */
export const relationTermSchema = z.object({
  kind: z.literal('relation'),
  id: z.string(),
  label: z.string().optional(),
  comment: z.string().optional(),
  domain: z.array(z.string()),
  rangeKind,
  range: z.array(z.string()),
  characteristics: z.array(characteristic),
  inverseOf: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of one TBox term, discriminated by `kind`. */
export const termSchema = z.discriminatedUnion('kind', [classTermSchema, relationTermSchema])

/** Durable shape of one entity. */
export const entitySchema = z.object({
  id: z.string(),
  classes: z.array(z.string()),
  label: z.string().optional(),
  comment: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of one asserted fact. Entailed facts are never stored. */
export const factSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  objectKind: rangeKind,
  source: z.string().optional(),
  confidence: z.number().optional(),
  violations: z.array(z.string()),
  createdAt: z.string(),
})

/**
 * Declare the ontology domain under one name: TBox terms, entities, and
 * asserted facts as three key-value tables. Facts are keyed by their composite
 * triple key, which makes re-asserting the same triple an idempotent overwrite
 * rather than a duplicate.
 *
 * The name is a parameter rather than a constant so one deployment can mount
 * several isolated graphs (per-team, per-project) from the same package by
 * inserting the plugin row more than once.
 * @param name - Domain name; doubles as the backend unit name.
 * @returns the domain spec to hand to `ctx.storageDomain.open`.
 */
export function ontologyDomainSpec(name: string) {
  return defineDomain({
    name: assertDomainName(name),
    version: ONTOLOGY_DOMAIN_VERSION,
    tables: {
      terms: domainTable<string, Term>(termSchema),
      entities: domainTable<string, Entity>(entitySchema),
      facts: domainTable<string, Fact>(factSchema),
    },
  })
}

/** The opened-domain type, derived from the spec factory. */
export type OntologyDomainSpec = ReturnType<typeof ontologyDomainSpec>
