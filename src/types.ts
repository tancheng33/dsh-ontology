/**
 * The ontology's data vocabulary: TBox terms (classes and relations), ABox
 * entities and facts, and the query/violation shapes shared by the pure logic,
 * the storage spec, and the model-facing tools.
 * @module dsh-ontology/types
 */

/**
 * Identifier syntax for every ontology term, entity, and predicate. Deliberately
 * narrow: ids appear inside composite fact keys (joined by `|`), inside prompt
 * text, and inside tool arguments, so a legible ASCII form keeps all three
 * unambiguous without escaping. Colons and dots allow namespacing
 * (`schema:Person`, `repo.Module`).
 */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/

/** Upper bound on one identifier, in characters. */
export const ID_MAX_LENGTH = 128

/** The separator joining a triple into its durable record key. */
export const FACT_KEY_SEPARATOR = '|'

/** What a relation may point at: other entities, or a bare literal value. */
export type RangeKind = 'entity' | 'literal'

/**
 * Logical characteristics a relation may carry. Each one licenses entailments
 * (see `entail`) and, for `functional`, an additional cardinality constraint.
 */
export type RelationCharacteristic = 'transitive' | 'symmetric' | 'functional'

/** A TBox class: a category entities can belong to. */
export interface ClassTerm {
  readonly kind: 'class'
  readonly id: string
  /** Human-readable name; falls back to `id` when absent. */
  readonly label?: string
  /** Free-text definition — what membership in this class actually means. */
  readonly comment?: string
  /** Direct superclasses. Membership propagates up the transitive closure. */
  readonly subClassOf: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** A TBox relation: a typed edge (or literal-valued attribute) between entities. */
export interface RelationTerm {
  readonly kind: 'relation'
  readonly id: string
  readonly label?: string
  readonly comment?: string
  /**
   * Classes a subject must belong to. Empty means unconstrained — the honest
   * encoding of "not yet decided", not a silent allow-all default.
   */
  readonly domain: readonly string[]
  /** Whether objects are entity references or literal values. */
  readonly rangeKind: RangeKind
  /** Classes an entity-valued object must belong to. Empty means unconstrained. */
  readonly range: readonly string[]
  readonly characteristics: readonly RelationCharacteristic[]
  /** Relation asserted in the opposite direction whenever this one holds. */
  readonly inverseOf?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One TBox term. */
export type Term = ClassTerm | RelationTerm

/** An ABox individual. */
export interface Entity {
  readonly id: string
  /** Direct classes; the effective set is their transitive `subClassOf` closure. */
  readonly classes: readonly string[]
  readonly label?: string
  readonly comment?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** An ABox triple. */
export interface Fact {
  readonly subject: string
  readonly predicate: string
  readonly object: string
  readonly objectKind: RangeKind
  /** Caller-supplied provenance — where this claim came from. */
  readonly source?: string
  /** Caller-supplied confidence in [0, 1]; absent means asserted as certain. */
  readonly confidence?: number
  /**
   * Constraint violations recorded at assert time. Always empty under
   * `strict: true` (violations reject instead); under `strict: false` this is
   * how a knowingly-inconsistent fact stays auditable.
   */
  readonly violations: readonly string[]
  readonly createdAt: string
}

/**
 * A fact plus how it was obtained. Asserted facts are durable; entailed facts
 * are derived on read and never stored, so retracting a premise removes them.
 */
export interface DerivedFact extends Fact {
  /** The characteristic that produced it, or `asserted` for a stored fact. */
  readonly via: 'asserted' | 'inverse' | 'symmetric' | 'transitive'
}

/**
 * The read surface one graph table exposes. A `Map` satisfies it, and so does
 * a thin adapter over a live storage table, which is how the store avoids
 * copying every record on each read generation.
 */
export interface GraphTable<V> {
  readonly size: number
  get(key: string): V | undefined
  has(key: string): boolean
  keys(): Iterable<string>
  values(): Iterable<V>
  entries(): Iterable<[string, V]>
}

/**
 * A read-only view of the whole graph. The pure logic operates only on this,
 * so every rule is testable without a storage backend or a Cordis context.
 *
 * Identity matters: derived structures (entailment, fact indexes) are
 * memoized per view object, so a producer hands out one view per write
 * generation and a fresh one after every write.
 */
export interface GraphView {
  readonly terms: GraphTable<Term>
  readonly entities: GraphTable<Entity>
  readonly facts: GraphTable<Fact>
  /**
   * Optional accelerator: the asserted facts whose subject is `subject`. A
   * producer that maintains a secondary index across writes supplies it so
   * per-write validation (the `functional` check) does not rescan the fact
   * table; without it consumers fall back to indexing the view.
   */
  readonly factsBySubject?: (subject: string) => Iterable<Fact>
}

/** One reason an input was rejected, phrased for the model that must fix it. */
export interface Violation {
  /** Stable machine code, e.g. `unknown-class`, `domain-mismatch`. */
  readonly code: string
  /** Actionable prose naming the offending value and the constraint it broke. */
  readonly message: string
}
