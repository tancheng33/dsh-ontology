# dsh-ontology

English | [中文](README.zh.md)

A typed, inference-capable **ontology** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — durable domain knowledge the agent declares, asserts against, and queries under schema constraints.

Most agent memory is a bag of strings: the agent writes prose, later reads prose, and nothing ever tells it that what it just recorded contradicts what it recorded last week. This plugin gives the agent a **vocabulary it must respect**. You declare what kinds of things exist and how they may relate; every claim is then checked against that model before it is stored, and claims that follow from other claims are derived rather than repeated.

```
ontology_define   declare classes and typed relations   (the TBox)
ontology_assert   record entities and facts             (the ABox, validated)
ontology_query    look things up, traverse, infer
ontology_retract  remove, with dependency protection
```

## Why a TBox, not a notes file

| | notes-style memory | dsh-ontology |
|---|---|---|
| Structure | free text | classes, typed relations, entities, triples |
| Bad input | silently stored | rejected, naming the constraint it broke |
| Implied facts | restated by hand, drift apart | derived on read from `transitive` / `symmetric` / `inverseOf` |
| Retraction | orphaned prose lingers | facts cascade with their entity; derived facts vanish with their premise |
| Reading it back | grep and hope | query by class (subclass-aware), triple pattern, neighbourhood, or shortest path |

The constraint is the point. When the agent asserts `ada depends_on api` and `depends_on` is declared `Component -> Component`, it gets back:

```
REJECTED ada depends_on api: ada is not in the domain of depends_on
  (requires one of: Component; has: Person)
```

That is a real signal — either the claim is wrong, or the model of the domain is incomplete. Free-text memory can produce neither.

## Install

```sh
dsh plugin --profile <name> add dsh-ontology
dsh --profile <name>
```

Or from a checkout / git host:

```sh
dsh plugin --profile <name> add ./dsh-ontology
dsh plugin --profile <name> add github:tancheng33/dsh-ontology
```

> A `github:` install builds from source, so pnpm ≥10 needs the build allowlisted. Add `allowBuilds: { dsh-ontology: true }` to the profile's `pnpm-workspace.yaml` and re-run, and pin a commit (`#<sha>`) so a later push cannot silently change what runs. Installing from npm needs no allowance.

The bundle brings its own storage stack (`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`) under the same row ids `dsh-web-app` uses, so it works in a bare profile and composes cleanly with one that already has storage. Data lands in `$DSH_HOME/storages/<domain>.json`.

## Configuration

Override any of these in your profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `domain` | `ontology` | Storage domain name; one name is one isolated graph. Must match `/^[a-z][a-z0-9_]*$/`. |
| `strict` | `true` | Reject facts that violate the vocabulary. `false` stores them with the violations recorded, for exploratory modelling. |
| `inference` | `true` | Allow queries to return entailed facts. |
| `promptSection` | `true` | Contribute the vocabulary summary to the system prompt. |
| `promptMaxTerms` | `60` | Upper bound on terms in that summary. |
| `promptOrder` | `150` | Where the section lands in the assembled prompt. |
| `defaultLimit` / `maxLimit` | `50` / `500` | Query result sizes. |
| `maxEntities` / `maxFacts` | `20000` / `100000` | Capacity guards; a write past the bound fails loudly. |

Running two isolated graphs is just two rows:

```yaml
- insert:
    - id: ontology-team
      name: dsh-ontology
      config: { domain: team_ontology, strict: true, inference: true, promptSection: true,
                promptMaxTerms: 60, promptOrder: 150, defaultLimit: 50, maxLimit: 500,
                maxEntities: 20000, maxFacts: 100000 }
```

(A patch replaces a row's whole `config`, so restate every key.)

## A worked example

**Declare the vocabulary.** Order does not matter — entries are resolved by repeated passes, so a subclass may precede its parent and a relation may precede its inverse.

```jsonc
// ontology_define
{
  "classes": [
    { "id": "Service", "subClassOf": ["Component"] },
    { "id": "Component", "comment": "A deployable unit of the system" },
    { "id": "Person" }
  ],
  "relations": [
    { "id": "depends_on", "domain": ["Component"], "range": ["Component"],
      "characteristics": ["transitive"] },
    { "id": "owns", "domain": ["Person"], "range": ["Component"], "inverseOf": "owned_by" },
    { "id": "owned_by", "domain": ["Component"], "range": ["Person"] },
    { "id": "version", "domain": ["Component"], "rangeKind": "literal" }
  ]
}
```

**Assert instances.** Entities are created before the facts of the same call, so one call introduces an individual and its relationships together.

```jsonc
// ontology_assert
{
  "entities": [
    { "id": "api", "classes": ["Service"] },
    { "id": "auth", "classes": ["Service"] },
    { "id": "pg", "classes": ["Component"] },
    { "id": "ada", "classes": ["Person"] }
  ],
  "facts": [
    { "subject": "api", "predicate": "depends_on", "object": "auth" },
    { "subject": "auth", "predicate": "depends_on", "object": "pg" },
    { "subject": "ada", "predicate": "owns", "object": "api", "source": "CODEOWNERS" },
    { "subject": "api", "predicate": "version", "object": "2.1.0" }
  ]
}
```

**Query, including what was never asserted.**

```jsonc
// ontology_query
{ "mode": "facts", "subject": "api", "predicate": "depends_on", "includeInferred": true }
```

```
api depends_on auth
api depends_on pg (inferred: transitive)
```

```jsonc
// ontology_query
{ "mode": "path", "from": "ada", "to": "pg", "depth": 4 }
```

```
connected in 3 step(s):
  ada owns api
  api depends_on auth
  auth depends_on pg
```

## Query modes

| Mode | Answers |
|---|---|
| `schema` | What vocabulary exists? (Start here.) |
| `stats` | How big is the graph, and how much is inferable? |
| `entities` | Which individuals are in class X (including its subclasses), or match text Y? |
| `facts` | Which triples match this pattern? Each omitted position is a wildcard. |
| `neighbors` | What surrounds this entity, out to depth N? |
| `path` | How are these two entities connected? |

## The rules it enforces

**Subsumption.** `subClassOf` is transitive: an entity declared `Service` is also a `Component`, so it satisfies a `Component` domain and is returned by a `Component` query. Cycles are refused at definition time — a cycle would make "is an X" unfalsifiable for every class on it.

**Domain and range.** A relation's `domain` constrains subjects, its `range` constrains objects, both closed under subsumption. An empty list means unconstrained, which is the honest encoding of "not yet decided" rather than a silent allow-all.

**Entity vs literal.** `rangeKind: "literal"` makes a relation attribute-valued (a version string, a date). A literal-valued relation can be neither symmetric, transitive, nor inverted — the derived triple would have a literal in subject position — and that incoherence is refused at definition time rather than producing nonsense later.

**Functional cardinality.** A `functional` relation admits at most one object per subject. A second, different object is a `functional-conflict`, not a silent overwrite. Re-asserting the *same* object stays idempotent.

**Entailment.** `transitive`, `symmetric`, and `inverseOf` are applied to a fixpoint, so the rules compose (the inverse of a transitive relation is itself closed transitively). Entailed facts are **derived on read and never stored** — retract a premise and everything resting on it disappears, with no stale derivation left behind. Each carries `via` naming the rule that produced it.

**Retraction safety.** Retracting an entity cascades to every fact mentioning it. Retracting a *term* is refused while anything still depends on it — a class that still classifies an entity or appears in a relation signature, a relation still asserted — and the refusal names the dependent.

## Code Mode

Every tool is reachable as a typed call, with the canonical JSON value (not the rendered prose) as the result:

```ts
const { facts } = await tools.ontology_query({
  mode: 'facts', predicate: 'depends_on', includeInferred: true,
})
const upstream = facts.filter(fact => fact.via === 'transitive').map(fact => fact.object)
```

## Using the reasoning core on its own

The rule engine is pure — no IO, no storage, no Cordis — and ships as its own entry point, so it can be used outside a harness:

```ts
import { entail, findPath, validateFactInput } from 'dsh-ontology/ontology'
```

## Development

```sh
pnpm install
pnpm test        # 47 unit tests: rules, tools, prompt section
pnpm typecheck
pnpm build
```

`tests/memory-domain.ts` is an in-memory stand-in for one open storage domain, so the store and the tools are tested end to end — real validation, real entailment, real tool results — without a backend.

## Requirements

- DeepSeek Harness `>= 0.1.0-rc.6`
- Node `^22.19 || >=24`

## License

MIT
