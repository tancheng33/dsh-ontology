/**
 * A typed, inference-capable ontology for DeepSeek Harness.
 *
 * The plugin opens one durable storage domain, registers the four model-facing
 * tools over it, and contributes a standing vocabulary section to the system
 * prompt. Everything it registers is a Cordis effect, so unloading the plugin
 * removes the tools, the prompt section, and the open domain together.
 * @module dsh-ontology
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { renderOntologySection } from './prompt.ts'
import { ontologyDomainSpec } from './spec.ts'
import { OntologyStore } from './store.ts'
import { createOntologyTools } from './tools.ts'
import { createIngestTools } from './ingest/index.ts'

export * from './types.ts'
export { OntologyStore } from './store.ts'
export type { StoreLimits, WriteOutcome } from './store.ts'
export { ontologyDomainSpec, ONTOLOGY_DOMAIN_VERSION, DOMAIN_NAME_PATTERN, assertDomainName } from './spec.ts'
export { renderOntologySection } from './prompt.ts'
export { createOntologyTools } from './tools.ts'
export type { ToolContext } from './tools.ts'
export { createIngestTools } from './ingest/index.ts'
export type { IngestDbInput, IngestDbOutput } from './ingest/types.ts'

export const name = 'ontology'

export const inject = ['tools', 'storageDomain', 'systemPrompt']

/** Deployment configuration for the ontology plugin. */
export interface Config {
  /** Storage domain name; one name is one isolated graph. */
  domain: string
  /** Reject TBox violations (`true`) or record them on the stored fact (`false`). */
  strict: boolean
  /** Whether queries may return facts entailed by relation characteristics. */
  inference: boolean
  /**
   * Cap on derived facts per read generation. Reaching it marks inferred
   * results incomplete rather than failing; raise it for graphs whose
   * transitive closures are large.
   */
  maxInferred: number
  /** Whether to contribute the vocabulary section to the system prompt. */
  promptSection: boolean
  /** Upper bound on vocabulary lines in that section. */
  promptMaxTerms: number
  /** Ordering of that section within the assembled prompt. */
  promptOrder: number
  /** Default and maximum result size for one query. */
  defaultLimit: number
  maxLimit: number
  /** Capacity guards; an assertion past the bound fails loudly. */
  maxEntities: number
  maxFacts: number
  /** Whether to enable database ingestion tools (default: true). */
  enableIngest?: boolean
}

export const Config: Schema<Config> = Schema.object({
  domain: Schema.string().default('ontology'),
  strict: Schema.boolean().default(true),
  inference: Schema.boolean().default(true),
  maxInferred: Schema.number().default(20000),
  promptSection: Schema.boolean().default(true),
  promptMaxTerms: Schema.number().default(60),
  // Tool guidance conventionally occupies 100–199.
  promptOrder: Schema.number().default(150),
  defaultLimit: Schema.number().default(50),
  maxLimit: Schema.number().default(500),
  maxEntities: Schema.number().default(20000),
  maxFacts: Schema.number().default(100000),
  enableIngest: Schema.boolean().default(true),
})

/**
 * Mount the ontology: open its domain, register the tools, and contribute the
 * prompt section.
 * @param ctx - The plugin context.
 * @param config - Validated deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(ontologyDomainSpec(config.domain))
  ctx.effect(() => () => void domain.close(), 'ontology.domainClose')

  const store = new OntologyStore(domain, {
    strict: config.strict,
    maxEntities: config.maxEntities,
    maxFacts: config.maxFacts,
  })

  const toolContext = {
    store,
    inference: config.inference,
    inferenceLimit: config.maxInferred,
    defaultLimit: config.defaultLimit,
    maxLimit: config.maxLimit,
    now: () => new Date().toISOString(),
  }

  // Register core ontology tools
  for (const tool of createOntologyTools(toolContext)) {
    ctx.tools.register(tool)
  }

  // Register database ingestion tools (if enabled)
  if (config.enableIngest !== false) {
    for (const tool of createIngestTools(toolContext)) {
      ctx.tools.register(tool)
    }
  }

  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: 'ontology',
      order: config.promptOrder,
      // Resolved per assembly: the section always reflects the current TBox.
      text: () => renderOntologySection(store.graph, config.promptMaxTerms),
    })
  }
}
