/**
 * The four model-facing tools: `ontology_define` (TBox), `ontology_assert`
 * (ABox), `ontology_query`, and `ontology_retract`. Each returns a canonical
 * JSON value designed to be useful programmatically in Code Mode, with human
 * explanation confined to `output.render`.
 * @module dsh-ontology/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ENTAILMENT_LIMIT,
  classAncestors,
  factIndex,
  findPath,
  neighbors,
  queryEntities,
  queryFacts,
  renderTBox,
  statsOf,
} from './ontology.ts'
import type { ClassInput, RelationInput } from './ontology.ts'
import type { OntologyStore } from './store.ts'
import type { DerivedFact, Violation } from './types.ts'

/** Runtime knobs the tools read from plugin configuration. */
export interface ToolContext {
  readonly store: OntologyStore
  /** Whether entailment is available at all; `false` forces `includeInferred` off. */
  readonly inference: boolean
  /** Derivation cap per read generation; defaults to {@link DEFAULT_ENTAILMENT_LIMIT}. */
  readonly inferenceLimit?: number
  /** Default and maximum result sizes for a query. */
  readonly defaultLimit: number
  readonly maxLimit: number
  /** Injected clock, so tests get deterministic timestamps. */
  readonly now: () => string
}

/** Reusable schema for a rejected input and why. */
const rejectionSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ref: { type: 'string', required: true, description: 'The rejected id or triple' },
      violations: { type: 'array', required: true, items: { type: 'string' } },
    },
  },
} as const

/** Canonical shape one fact takes in every tool result. */
const factSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string', required: true },
    predicate: { type: 'string', required: true },
    object: { type: 'string', required: true },
    objectKind: { type: 'string', required: true },
    via: { type: 'string', required: true, description: 'asserted | inverse | symmetric | transitive' },
    source: { type: 'string' },
    confidence: { type: 'number' },
    violations: { type: 'array', items: { type: 'string' } },
  },
} as const

/** The projected fact shape every result renderer receives. */
interface FactValue {
  readonly subject: string
  readonly predicate: string
  readonly object: string
  readonly objectKind: string
  readonly via: string
  readonly source?: string
  readonly confidence?: number
  readonly violations?: string[]
}

/** One rejected input, paired with the reasons. */
interface Rejection {
  ref: string
  violations: string[]
}

/**
 * Project a fact into the canonical tool-result shape, dropping absent
 * optional fields so the value stays lossless JSON.
 * @param fact - The fact to project.
 * @returns the JSON record.
 */
function projectFact(fact: DerivedFact): FactValue {
  return {
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    objectKind: fact.objectKind,
    via: fact.via,
    ...(fact.source === undefined ? {} : { source: fact.source }),
    ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
    ...(fact.violations.length === 0 ? {} : { violations: [...fact.violations] }),
  }
}

/**
 * Render a fact as one line of prose for the model.
 * @param fact - The fact to render.
 * @returns the line.
 */
function factLine(fact: FactValue): string {
  const object = fact.objectKind === 'literal' ? JSON.stringify(fact.object) : fact.object
  const via = fact.via === 'asserted' ? '' : ` (inferred: ${fact.via})`
  const violations = fact.violations ?? []
  const flags = violations.length === 0 ? '' : ` ⚠ ${violations.join('; ')}`
  return `${fact.subject} ${fact.predicate} ${object}${via}${flags}`
}

/**
 * Flatten violations into the message strings a tool result carries.
 * @param violations - The violations to flatten.
 * @returns their messages.
 */
function messagesOf(violations: readonly Violation[]): string[] {
  return violations.map(violation => violation.message)
}

/**
 * Clamp a requested result size into the configured bounds.
 * @param requested - The caller's `limit`, when given.
 * @param context - Tool configuration.
 * @returns the effective limit.
 */
function resolveLimit(requested: number | undefined, context: ToolContext): number {
  if (requested === undefined) return context.defaultLimit
  return Math.max(1, Math.min(Math.floor(requested), context.maxLimit))
}

/**
 * Build the `ontology_define` tool: declares the vocabulary the graph may use.
 *
 * Definitions are applied by repeated passes rather than in argument order, so
 * a class may be declared after the subclass that references it and a relation
 * after its inverse. Only inputs that never become admissible are rejected.
 * @param context - Tool configuration.
 * @returns the tool definition.
 */
export function defineOntologyDefineTool(context: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ontology_define',
    description:
      'Declare ontology vocabulary (the TBox): classes and the typed relations between them. '
      + 'Do this BEFORE asserting facts — ontology_assert rejects an undeclared predicate. '
      + 'A relation has a domain (subject classes), a range (object classes, or rangeKind '
      + '"literal" for attribute values like a date or a version string), and optional '
      + 'characteristics that let the graph infer facts you never asserted: "transitive" '
      + '(a part_of b, b part_of c ⇒ a part_of c), "symmetric" (both directions), '
      + '"functional" (at most one object per subject — a second one is rejected as a conflict). '
      + '"inverseOf" pairs a relation with its reverse (owns / owned_by). Order does not matter: '
      + 'entries are resolved by repeated passes. Re-defining an existing term replaces it wholesale; '
      + 'if that would invalidate facts already asserted, the redefinition is rejected (strict) or '
      + 'applied with the invalidated facts listed as warnings (non-strict).',
    parameters: {
      classes: {
        type: 'array',
        description: 'Classes to declare.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Identifier, e.g. Service or schema:Person' },
            label: { type: 'string', description: 'Human-readable name' },
            comment: { type: 'string', description: 'What membership in this class means' },
            subClassOf: {
              type: 'array',
              items: { type: 'string' },
              description: 'Direct superclasses; membership propagates upward',
            },
          },
        },
      },
      relations: {
        type: 'array',
        description: 'Relations to declare.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Identifier, e.g. depends_on' },
            label: { type: 'string' },
            comment: { type: 'string', description: 'What asserting this relation claims' },
            domain: {
              type: 'array',
              items: { type: 'string' },
              description: 'Classes a subject must belong to; omit to leave unconstrained',
            },
            rangeKind: {
              type: 'string',
              enum: ['entity', 'literal'],
              description: 'Whether objects are entities (default) or literal values',
            },
            range: {
              type: 'array',
              items: { type: 'string' },
              description: 'Classes an entity object must belong to; invalid when rangeKind is "literal"',
            },
            characteristics: {
              type: 'array',
              items: { type: 'string', enum: ['transitive', 'symmetric', 'functional'] },
            },
            inverseOf: { type: 'string', description: 'Relation that holds in the opposite direction' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          classes: { type: 'array', required: true, items: { type: 'string' } },
          relations: { type: 'array', required: true, items: { type: 'string' } },
          rejected: { ...rejectionSchema, required: true },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Redefinitions applied under strict: false that invalidated stored facts',
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `defined ${value.classes.length} class(es), ${value.relations.length} relation(s)`,
        ]
        if (value.classes.length > 0) lines.push(`classes: ${value.classes.join(', ')}`)
        if (value.relations.length > 0) lines.push(`relations: ${value.relations.join(', ')}`)
        for (const warning of value.warnings) lines.push(`WARNING ${warning}`)
        for (const rejection of value.rejected) {
          lines.push(`REJECTED ${rejection.ref}: ${rejection.violations.join('; ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const now = context.now()
      const definedClasses: string[] = []
      const definedRelations: string[] = []
      const rejected: Rejection[] = []
      const warnings: string[] = []

      // Repeated passes: a definition that only fails because a term it
      // references is later in the same call succeeds on the next pass.
      let pending: { kind: 'class' | 'relation', input: ClassInput | RelationInput }[] = [
        ...(args.classes ?? []).map(input => ({ kind: 'class' as const, input: input as ClassInput })),
        ...(args.relations ?? []).map(input => ({ kind: 'relation' as const, input: input as RelationInput })),
      ]
      while (pending.length > 0) {
        const stillPending: typeof pending = []
        const failures = new Map<string, string[]>()
        for (const item of pending) {
          const outcome = item.kind === 'class'
            ? await context.store.defineClass(item.input as ClassInput, now)
            : await context.store.defineRelation(item.input as RelationInput, now)
          if (outcome.ok) {
            if (item.kind === 'class') definedClasses.push(item.input.id)
            else definedRelations.push(item.input.id)
            for (const violation of outcome.violations) warnings.push(`${item.input.id}: ${violation.message}`)
          } else {
            stillPending.push(item)
            failures.set(item.input.id, messagesOf(outcome.violations))
          }
        }
        if (stillPending.length === pending.length) {
          // A whole pass with no progress: the remainder can never resolve.
          for (const item of stillPending) {
            rejected.push({ ref: item.input.id, violations: failures.get(item.input.id) ?? ['rejected'] })
          }
          break
        }
        pending = stillPending
      }

      return { classes: definedClasses, relations: definedRelations, rejected, warnings }
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'edit',
      title: `ontology define (${(args.classes ?? []).length} class, ${(args.relations ?? []).length} relation)`,
    }),
  })
}

/**
 * Build the `ontology_assert` tool: records instance data against the TBox.
 * @param context - Tool configuration.
 * @returns the tool definition.
 */
export function defineOntologyAssertTool(context: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ontology_assert',
    description:
      'Record entities and facts in the ontology. Entities in this call are created before its '
      + 'facts, so one call can introduce an individual and its relationships together. Every fact '
      + 'is checked against the declared vocabulary: the predicate must exist, the subject must be '
      + 'in its domain, and the object must be a known entity in its range (or a literal, for a '
      + 'literal-valued relation). A rejected fact tells you exactly which constraint failed — fix '
      + 'the input or extend the vocabulary with ontology_define, do not work around it. The same '
      + 'applies before you call: if what you were told does not fit any relation, do not record a '
      + 'different, better-fitting claim in its place; report the mismatch instead. '
      + 'Re-asserting the same triple is idempotent; an entity\'s classes accumulate across calls. '
      + 'Use "merges" when two ids turn out to name the same individual: every fact about "from" is '
      + 'rewritten onto "into", classes are unioned, and "from" disappears.',
    parameters: {
      merges: {
        type: 'array',
        description: 'Entity pairs to merge, applied after the entities and facts of this call.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', required: true, description: 'Entity id to absorb; removed' },
            into: { type: 'string', required: true, description: 'Surviving entity id' },
          },
        },
      },
      entities: {
        type: 'array',
        description: 'Individuals to record.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            classes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Declared classes; each must already exist',
            },
            label: { type: 'string' },
            comment: { type: 'string', description: 'What is known about this individual' },
          },
        },
      },
      facts: {
        type: 'array',
        description: 'Triples to record.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string', required: true, description: 'Entity id' },
            predicate: { type: 'string', required: true, description: 'Declared relation id' },
            object: {
              type: 'string',
              required: true,
              description: 'Entity id, or a literal value for a literal-valued relation',
            },
            source: { type: 'string', description: 'Where this claim came from' },
            confidence: { type: 'number', description: 'Confidence in [0, 1]; omit when certain' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entities: { type: 'array', required: true, items: { type: 'string' } },
          facts: { type: 'array', required: true, items: { type: 'string' } },
          merged: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Completed merges as "from -> into (n facts rewritten)"',
          },
          rejected: { ...rejectionSchema, required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`asserted ${value.entities.length} entity(ies), ${value.facts.length} fact(s)`]
        for (const merge of value.merged) lines.push(`merged ${merge}`)
        for (const warning of value.warnings) lines.push(`WARNING ${warning}`)
        for (const rejection of value.rejected) {
          lines.push(`REJECTED ${rejection.ref}: ${rejection.violations.join('; ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const now = context.now()
      const assertedEntities: string[] = []
      const assertedFacts: string[] = []
      const merged: string[] = []
      const rejected: Rejection[] = []
      const warnings: string[] = []

      for (const entity of args.entities ?? []) {
        const outcome = await context.store.assertEntity(entity, now)
        if (outcome.ok) assertedEntities.push(entity.id)
        else rejected.push({ ref: entity.id, violations: messagesOf(outcome.violations) })
      }
      for (const fact of args.facts ?? []) {
        const ref = `${fact.subject} ${fact.predicate} ${fact.object}`
        const outcome = await context.store.assertFact(fact, now)
        if (!outcome.ok) {
          rejected.push({ ref, violations: messagesOf(outcome.violations) })
          continue
        }
        assertedFacts.push(ref)
        // Non-strict mode stores the fact anyway; surface the inconsistency.
        if (outcome.violations.length > 0) {
          warnings.push(`${ref}: ${messagesOf(outcome.violations).join('; ')}`)
        }
      }
      for (const merge of args.merges ?? []) {
        const ref = `${merge.from} -> ${merge.into}`
        const outcome = await context.store.mergeEntities(merge.from, merge.into, now)
        if (!outcome.ok) {
          rejected.push({ ref, violations: messagesOf(outcome.violations) })
          continue
        }
        merged.push(`${ref} (${outcome.facts} facts rewritten)`)
        if (outcome.violations.length > 0) warnings.push(`${ref}: ${messagesOf(outcome.violations).join('; ')}`)
      }
      return { entities: assertedEntities, facts: assertedFacts, merged, rejected, warnings }
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'edit',
      title: `ontology assert (${(args.entities ?? []).length} entity, ${(args.facts ?? []).length} fact`
        + `${(args.merges ?? []).length > 0 ? `, ${(args.merges ?? []).length} merge` : ''})`,
    }),
  })
}

/**
 * Build the `ontology_query` tool: the only read path into the graph.
 *
 * One tool with a `mode` discriminant rather than six tools, so the agent's
 * visible tool surface stays small while every access pattern the graph
 * supports — lookup, traversal, connection-finding, and schema inspection —
 * stays reachable.
 * @param context - Tool configuration.
 * @returns the tool definition.
 */
export function defineOntologyQueryTool(context: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ontology_query',
    description:
      'Read the ontology. Modes: "schema" lists the declared vocabulary (start here when you do not '
      + 'know what exists); "stats" counts everything; "entities" finds individuals by class '
      + '(including subclasses) and/or a text match; "facts" matches a triple pattern, where each '
      + 'omitted position is a wildcard; "neighbors" expands outward from one entity to a bounded '
      + 'depth; "path" finds the shortest chain of relations connecting two entities; "dump" returns '
      + 'the whole asserted graph (terms, entities, facts) as data, for export or backup. Set '
      + 'includeInferred to also get facts entailed by transitive/symmetric/inverse relations — '
      + 'those are derived on read and marked with how they were obtained.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['schema', 'stats', 'entities', 'facts', 'neighbors', 'path', 'dump'],
      },
      class: { type: 'string', description: 'entities mode: restrict to this class and its subclasses' },
      search: { type: 'string', description: 'entities mode: case-insensitive substring of id/label/comment' },
      subject: { type: 'string', description: 'facts mode: match this subject' },
      predicate: { type: 'string', description: 'facts mode: match this relation' },
      object: { type: 'string', description: 'facts mode: match this object' },
      entity: { type: 'string', description: 'neighbors mode: the entity to expand from' },
      from: { type: 'string', description: 'path mode: start entity' },
      to: { type: 'string', description: 'path mode: target entity' },
      depth: { type: 'integer', description: 'neighbors/path mode: maximum edges to traverse (default 2)' },
      includeInferred: { type: 'boolean', description: 'Include entailed facts (default false)' },
      limit: { type: 'integer', description: 'Maximum results (dump mode: per collection, default the maximum)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          terms: {
            type: 'array',
            description: 'dump mode: the vocabulary',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                id: { type: 'string', required: true },
                label: { type: 'string' },
                comment: { type: 'string' },
                subClassOf: { type: 'array', items: { type: 'string' } },
                domain: { type: 'array', items: { type: 'string' } },
                rangeKind: { type: 'string' },
                range: { type: 'array', items: { type: 'string' } },
                characteristics: { type: 'array', items: { type: 'string' } },
                inverseOf: { type: 'string' },
              },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              classes: { type: 'integer', required: true },
              relations: { type: 'integer', required: true },
              entities: { type: 'integer', required: true },
              facts: { type: 'integer', required: true },
              inferredFacts: { type: 'integer', required: true },
            },
          },
          schema: { type: 'array', items: { type: 'string' } },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                classes: { type: 'array', required: true, items: { type: 'string' } },
                allClasses: {
                  type: 'array',
                  required: true,
                  items: { type: 'string' },
                  description: 'Declared classes closed under subClassOf',
                },
                label: { type: 'string' },
                comment: { type: 'string' },
              },
            },
          },
          facts: { type: 'array', items: factSchema },
          path: { type: 'array', items: factSchema },
          connected: { type: 'boolean', description: 'path mode: whether a path was found' },
          reached: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean', description: 'Whether the limit cut the result short' },
          inferenceTruncated: {
            type: 'boolean',
            description: 'Whether entailment hit its derivation cap, so inferred results are incomplete',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderQuery(value) }],
    },
    async execute(args) {
      const graph = context.store.graph
      const includeInferred = context.inference && (args.includeInferred ?? false)
      const limit = resolveLimit(args.limit, context)
      const depth = Math.max(1, Math.min(args.depth ?? 2, 8))
      const inferenceLimit = context.inferenceLimit ?? DEFAULT_ENTAILMENT_LIMIT
      /** Set only when inference was in scope and was cut short. */
      const inferenceFlag = (): { inferenceTruncated?: boolean } =>
        includeInferred && factIndex(graph, true, inferenceLimit).truncated ? { inferenceTruncated: true } : {}

      switch (args.mode) {
        case 'stats': {
          const stats = statsOf(graph)
          const inferred = context.inference ? factIndex(graph, true, inferenceLimit) : undefined
          return {
            mode: 'stats',
            stats: {
              ...stats,
              inferredFacts: inferred === undefined ? 0 : inferred.facts.length - stats.facts,
            },
            ...(inferred?.truncated === true ? { inferenceTruncated: true } : {}),
          }
        }
        case 'schema':
          return { mode: 'schema', schema: renderTBox(graph, limit) }
        case 'entities': {
          const found = queryEntities(graph, {
            ...(args.class === undefined ? {} : { classId: args.class }),
            ...(args.search === undefined ? {} : { search: args.search }),
            limit: limit + 1,
          })
          const page = found.slice(0, limit)
          return {
            mode: 'entities',
            entities: page.map(entity => ({
              id: entity.id,
              classes: [...entity.classes],
              allClasses: [...new Set(entity.classes.flatMap(id => [...classAncestors(graph.terms, id)]))].sort(),
              ...(entity.label === undefined ? {} : { label: entity.label }),
              ...(entity.comment === undefined ? {} : { comment: entity.comment }),
            })),
            truncated: found.length > page.length,
          }
        }
        case 'facts': {
          const found = queryFacts(graph, {
            ...(args.subject === undefined ? {} : { subject: args.subject }),
            ...(args.predicate === undefined ? {} : { predicate: args.predicate }),
            ...(args.object === undefined ? {} : { object: args.object }),
            includeInferred,
            inferenceLimit,
            limit: limit + 1,
          })
          const page = found.slice(0, limit)
          return { mode: 'facts', facts: page.map(projectFact), truncated: found.length > page.length, ...inferenceFlag() }
        }
        case 'neighbors': {
          if (args.entity === undefined) throw new Error('neighbors mode requires "entity"')
          const result = neighbors(graph, args.entity, depth, includeInferred, inferenceLimit)
          const page = result.facts.slice(0, limit)
          return {
            mode: 'neighbors',
            reached: result.reached,
            facts: page.map(projectFact),
            truncated: result.facts.length > page.length,
            ...inferenceFlag(),
          }
        }
        case 'dump': {
          const cap = args.limit === undefined ? context.maxLimit : resolveLimit(args.limit, context)
          const terms = [...graph.terms.values()]
          const entities = [...graph.entities.values()]
          const facts = factIndex(graph, false).facts
          return {
            mode: 'dump',
            terms: terms.slice(0, cap).map(term => term.kind === 'class'
              ? {
                  kind: 'class',
                  id: term.id,
                  ...(term.label === undefined ? {} : { label: term.label }),
                  ...(term.comment === undefined ? {} : { comment: term.comment }),
                  subClassOf: [...term.subClassOf],
                }
              : {
                  kind: 'relation',
                  id: term.id,
                  ...(term.label === undefined ? {} : { label: term.label }),
                  ...(term.comment === undefined ? {} : { comment: term.comment }),
                  domain: [...term.domain],
                  rangeKind: term.rangeKind,
                  range: [...term.range],
                  characteristics: [...term.characteristics],
                  ...(term.inverseOf === undefined ? {} : { inverseOf: term.inverseOf }),
                }),
            entities: entities.slice(0, cap).map(entity => ({
              id: entity.id,
              classes: [...entity.classes],
              allClasses: [...entity.classes],
              ...(entity.label === undefined ? {} : { label: entity.label }),
              ...(entity.comment === undefined ? {} : { comment: entity.comment }),
            })),
            facts: facts.slice(0, cap).map(projectFact),
            truncated: terms.length > cap || entities.length > cap || facts.length > cap,
          }
        }
        case 'path': {
          if (args.from === undefined || args.to === undefined) {
            throw new Error('path mode requires "from" and "to"')
          }
          const path = findPath(graph, args.from, args.to, depth, includeInferred, inferenceLimit)
          return {
            mode: 'path',
            connected: path !== undefined,
            path: (path ?? []).map(projectFact),
            ...inferenceFlag(),
          }
        }
        default:
          throw new Error(`unsupported mode ${String(args.mode)}`)
      }
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: `ontology query (${args.mode})` }),
  })
}

/**
 * Render a query result as prose for the model.
 * @param value - The canonical query value.
 * @returns the rendered text.
 */
function renderQuery(value: {
  mode: string
  terms?: { kind: string, id: string }[]
  stats?: { classes: number, relations: number, entities: number, facts: number, inferredFacts: number }
  schema?: string[]
  entities?: { id: string, classes: string[], allClasses: string[], label?: string, comment?: string }[]
  facts?: FactValue[]
  path?: FactValue[]
  connected?: boolean
  reached?: string[]
  truncated?: boolean
  inferenceTruncated?: boolean
}): string {
  const lines: string[] = []

  switch (value.mode) {
    case 'stats':
      if (value.stats !== undefined) {
        lines.push(
          `${value.stats.classes} classes, ${value.stats.relations} relations, `
          + `${value.stats.entities} entities, ${value.stats.facts} asserted facts`
          + (value.stats.inferredFacts > 0 ? `, ${value.stats.inferredFacts} inferable` : ''),
        )
      }
      break
    case 'schema':
      lines.push(...(value.schema ?? []))
      if (lines.length === 0) lines.push('The ontology has no vocabulary yet — define classes and relations first.')
      break
    case 'entities':
      for (const entity of value.entities ?? []) {
        const classes = entity.classes.length > 0 ? ` : ${entity.classes.join(', ')}` : ''
        const gloss = entity.comment ?? entity.label
        lines.push(`${entity.id}${classes}${gloss === undefined ? '' : `  — ${gloss}`}`)
      }
      if (lines.length === 0) lines.push('no matching entities')
      break
    case 'facts':
      for (const fact of value.facts ?? []) lines.push(factLine(fact))
      if (lines.length === 0) lines.push('no matching facts')
      break
    case 'neighbors':
      lines.push(`reached ${(value.reached ?? []).length} entity(ies)`)
      for (const fact of value.facts ?? []) lines.push(factLine(fact))
      break
    case 'dump':
      lines.push(
        `${(value.terms ?? []).length} term(s), ${(value.entities ?? []).length} entity(ies), `
        + `${(value.facts ?? []).length} fact(s); the structured value carries the full records`,
      )
      break
    case 'path':
      if (value.connected === true) {
        lines.push(`connected in ${(value.path ?? []).length} step(s):`)
        for (const fact of value.path ?? []) lines.push(`  ${factLine(fact)}`)
      } else {
        lines.push('no path within the given depth')
      }
      break
    default:
      lines.push(`unknown mode ${value.mode}`)
  }
  if (value.truncated === true) lines.push('… truncated; narrow the query or raise "limit"')
  if (value.inferenceTruncated === true) {
    lines.push(
      '⚠ inference stopped at the derivation cap (maxInferred); inferred results are incomplete',
    )
  }
  return lines.join('\n')
}

/**
 * Build the `ontology_retract` tool: the only write path that removes.
 * @param context - Tool configuration.
 * @returns the tool definition.
 */
export function defineOntologyRetractTool(context: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ontology_retract',
    description:
      'Remove things from the ontology. Retracting an entity also removes every fact mentioning it. '
      + 'Retracting a term is refused while anything still depends on it (a class that still '
      + 'classifies an entity or appears in a relation signature, a relation still asserted) — clear '
      + 'the dependents first. Inferred facts have no independent existence: retract a premise and '
      + 'everything derived from it disappears with it.',
    parameters: {
      terms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Class or relation ids to remove from the vocabulary',
      },
      entities: { type: 'array', items: { type: 'string' }, description: 'Entity ids to remove' },
      facts: {
        type: 'array',
        description: 'Individual triples to remove',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string', required: true },
            predicate: { type: 'string', required: true },
            object: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terms: { type: 'array', required: true, items: { type: 'string' } },
          entities: { type: 'array', required: true, items: { type: 'string' } },
          facts: { type: 'array', required: true, items: { type: 'string' } },
          cascadedFacts: {
            type: 'integer',
            required: true,
            description: 'Facts removed along with their entities',
          },
          refused: { ...rejectionSchema, required: true },
          missing: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `retracted ${value.terms.length} term(s), ${value.entities.length} entity(ies), `
          + `${value.facts.length} fact(s)`
          + (value.cascadedFacts > 0 ? ` (+${value.cascadedFacts} cascaded)` : ''),
        ]
        for (const refusal of value.refused) lines.push(`REFUSED ${refusal.ref}: ${refusal.violations.join('; ')}`)
        if (value.missing.length > 0) lines.push(`not present: ${value.missing.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const terms: string[] = []
      const entities: string[] = []
      const facts: string[] = []
      const refused: Rejection[] = []
      const missing: string[] = []
      let cascadedFacts = 0

      for (const id of args.terms ?? []) {
        const outcome = await context.store.retractTerm(id)
        if (!outcome.ok) refused.push({ ref: id, violations: messagesOf(outcome.violations) })
        else if (outcome.removed) terms.push(id)
        else missing.push(id)
      }
      for (const id of args.entities ?? []) {
        const outcome = await context.store.retractEntity(id)
        cascadedFacts += outcome.facts
        if (outcome.removed) entities.push(id)
        else missing.push(id)
      }
      for (const fact of args.facts ?? []) {
        const ref = `${fact.subject} ${fact.predicate} ${fact.object}`
        if (await context.store.retractFact(fact.subject, fact.predicate, fact.object)) facts.push(ref)
        else missing.push(ref)
      }
      return { terms, entities, facts, cascadedFacts, refused, missing }
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'edit',
      title: `ontology retract (${(args.terms ?? []).length + (args.entities ?? []).length + (args.facts ?? []).length} item)`,
    }),
  })
}

/**
 * Build every ontology tool.
 * @param context - Tool configuration.
 * @returns the four tool definitions, in registration order.
 */
export function createOntologyTools(context: ToolContext): ToolDefinition[] {
  return [
    defineOntologyDefineTool(context),
    defineOntologyAssertTool(context),
    defineOntologyQueryTool(context),
    defineOntologyRetractTool(context),
  ]
}
