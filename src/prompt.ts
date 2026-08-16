/**
 * The system-prompt contribution: a compact standing description of the graph
 * the agent has, so it knows the capability exists and what vocabulary is
 * already in use without spending a tool call to find out.
 * @module dsh-ontology/prompt
 */

import { renderTBox, statsOf } from './ontology.ts'
import type { GraphView } from './types.ts'

/**
 * Render the ontology section for one assembly.
 *
 * Deliberately vocabulary-only: the TBox is small, slow-moving, and cheap to
 * carry, while instance data is large, fast-moving, and belongs behind
 * `ontology_query`. An empty graph gets a different section — one that explains
 * what the graph is for — because listing nothing teaches the model nothing.
 * @param graph - The current graph.
 * @param maxTerms - Upper bound on vocabulary lines.
 * @returns the section text.
 */
export function renderOntologySection(graph: GraphView, maxTerms: number): string {
  const stats = statsOf(graph)
  const lines = ['# Ontology']

  if (stats.classes === 0 && stats.relations === 0) {
    lines.push(
      '',
      'A durable, typed knowledge graph is available and currently EMPTY. It survives across '
      + 'sessions, unlike this conversation. When you establish structural facts worth keeping — '
      + 'the components of a system and how they depend on each other, the people and their roles, '
      + 'the entities of a domain and their relationships — declare the vocabulary with '
      + '`ontology_define` and record the instances with `ontology_assert`, rather than only '
      + 'stating them in your reply.',
      '',
      'Do not use it as a scratchpad for transient facts, and do not create vocabulary you will '
      + 'not assert against.',
    )
    return lines.join('\n')
  }

  lines.push(
    '',
    `A durable, typed knowledge graph persists across sessions: ${stats.classes} classes, `
    + `${stats.relations} relations, ${stats.entities} entities, ${stats.facts} facts. `
    + 'Its declared vocabulary:',
    '',
    ...renderTBox(graph, maxTerms).map(line => `- ${line}`),
    '',
    'Read it with `ontology_query` before assuming any of this is unknown to you; extend it with '
    + '`ontology_define` (vocabulary) and `ontology_assert` (instances). Assertions are checked '
    + 'against the vocabulary, so a rejection means the claim does not fit the declared model — '
    + 'either the claim is wrong or the model needs extending. Reuse existing terms instead of '
    + 'coining near-duplicates.',
  )
  return lines.join('\n')
}
