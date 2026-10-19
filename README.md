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

The ontology persists through the storage stack (`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`) that `dsh-base` ships since **dsh 0.1.5**, so the bundle contributes only its own `ontology` row. It therefore needs dsh ≥ 0.1.5-rc.2; on older harnesses add the three storage rows to your profile patch yourself. Data lands in `$DSH_HOME/storages/<domain>.json`.

## Configuration

Override any of these in your profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `domain` | `ontology` | Storage domain name; one name is one isolated graph. Must match `/^[a-z][a-z0-9_]*$/`. |
| `strict` | `true` | Reject facts that violate the vocabulary. `false` stores them with the violations recorded, for exploratory modelling. |
| `inference` | `true` | Allow queries to return entailed facts. |
| `maxInferred` | `20000` | Cap on derived facts per read. Past it, results carry `inferenceTruncated: true` and the rendered text says so; raise it for graphs with large transitive closures. |
| `promptSection` | `true` | Contribute the vocabulary summary to the system prompt. |
| `promptMaxTerms` | `60` | Upper bound on terms in that summary. |
| `promptOrder` | `150` | Where the section lands in the assembled prompt. |
| `defaultLimit` / `maxLimit` | `50` / `500` | Query result sizes. |
| `maxEntities` / `maxFacts` | `20000` / `100000` | Capacity guards; a write past the bound fails loudly. |
| `enableIngest` | `true` | Whether to register the database ingestion tools. |

Running two isolated graphs is just two rows:

```yaml
- insert:
    - id: ontology-team
      name: dsh-ontology
      config: { domain: team_ontology, strict: true, inference: true, maxInferred: 20000,
                promptSection: true, promptMaxTerms: 60, promptOrder: 150,
                defaultLimit: 50, maxLimit: 500, maxEntities: 20000, maxFacts: 100000 }
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
| `dump` | Everything asserted — terms, entities, facts — as data, for export or backup. Re-import is `ontology_define` + `ontology_assert`. |

## Complete end-to-end example: From database to queries

This section shows a complete workflow: defining vocabulary, importing data from a relational database, and querying the resulting knowledge graph.

### Step 1: Prepare your database

Suppose you have a business database with users, teams, suppliers, and orders:

```sql
CREATE TABLE teams (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  region      VARCHAR(50)
);

CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  full_name   VARCHAR(100) NOT NULL,
  email       VARCHAR(100),
  team_id     INTEGER REFERENCES teams(id),
  manager_id  INTEGER REFERENCES users(id)
);

CREATE TABLE suppliers (
  id            SERIAL PRIMARY KEY,
  company_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(100),
  country       VARCHAR(10)
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  order_no    VARCHAR(50) NOT NULL,
  amount      NUMERIC(12,2),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id)
);
```

### Step 2: Define the vocabulary

Before importing, tell the ontology what classes and relations exist:

```jsonc
// ontology_define
{
  "classes": [
    { "id": "Team" },
    { "id": "Person" },
    { "id": "Supplier" },
    { "id": "Order" }
  ],
  "relations": [
    // Entity relations (from foreign keys)
    { "id": "member_of", "domain": ["Person"], "range": ["Team"] },
    { "id": "reports_to", "domain": ["Person"], "range": ["Person"], 
      "characteristics": ["transitive"] },
    { "id": "placed_by", "domain": ["Order"], "range": ["Person"], "inverseOf": "placed" },
    { "id": "placed", "domain": ["Person"], "range": ["Order"] },
    { "id": "supplied_by", "domain": ["Order"], "range": ["Supplier"], "inverseOf": "supplies" },
    { "id": "supplies", "domain": ["Supplier"], "range": ["Order"] },
    
    // Literal relations (from regular columns)
    { "id": "region", "domain": ["Team"], "rangeKind": "literal" },
    { "id": "has_email", "domain": ["Person"], "rangeKind": "literal" },
    { "id": "contact_email", "domain": ["Supplier"], "rangeKind": "literal" },
    { "id": "country_code", "domain": ["Supplier"], "rangeKind": "literal" },
    { "id": "order_amount", "domain": ["Order"], "rangeKind": "literal" },
    { "id": "order_status", "domain": ["Order"], "rangeKind": "literal" }
  ]
}
```

Returns: `defined 4 class(es), 12 relation(s)`

### Step 3: Import the database

Now map your tables to the vocabulary and import:

```jsonc
// ontology_ingest_db
{
  "connection": {
    "type": "postgres",
    "host": "localhost",
    "database": "business",
    "user": "readonly",
    "password": "${DB_PASSWORD}"   // read from env, never inlined
  },
  "mapping": {
    "tables": [
      {
        "table": "teams",
        "entityClass": "Team",
        "idColumn": "id",
        "labelColumn": "name",
        "attributes": [
          { "column": "region", "relation": "region" }
        ]
      },
      {
        "table": "users",
        "entityClass": "Person",
        "idColumn": "id",
        "labelColumn": "full_name",
        "attributes": [
          { "column": "email", "relation": "has_email", "transform": "lowercase" }
        ],
        "foreignKeys": [
          { "column": "team_id", "targetTable": "teams", "relation": "member_of" },
          { "column": "manager_id", "targetTable": "users", "relation": "reports_to", "nullable": true }
        ]
      },
      {
        "table": "suppliers",
        "entityClass": "Supplier",
        "idColumn": "id",
        "labelColumn": "company_name",
        "attributes": [
          { "column": "contact_email", "relation": "contact_email" },
          { "column": "country", "relation": "country_code", "transform": "uppercase" }
        ]
      },
      {
        "table": "orders",
        "entityClass": "Order",
        "idColumn": "id",
        "labelColumn": "order_no",
        "attributes": [
          { "column": "amount", "relation": "order_amount" },
          { "column": "status", "relation": "order_status" }
        ],
        "foreignKeys": [
          { "column": "user_id", "targetTable": "users", "relation": "placed_by" },
          { "column": "supplier_id", "targetTable": "suppliers", "relation": "supplied_by" }
        ]
      }
    ]
  }
}
```

Returns: `ingested 14 entit(ies) and 32 fact(s) in 245ms (mode: full)`

What happened:
- **4 users** → entities `users_1`, `users_2`, `users_3`, `users_4` with class `Person`
- **2 teams** → entities `teams_1`, `teams_2` with class `Team`
- **3 suppliers** → entities `suppliers_101`, `suppliers_102`, `suppliers_103` with class `Supplier`
- **5 orders** → entities `orders_1001` through `orders_1005` with class `Order`
- **Foreign keys** became relations: `orders_1001 placed_by users_1`, `orders_1001 supplied_by suppliers_101`, etc.
- **Attributes** became literal facts: `users_1 has_email "zhangsan@example.com"`, `orders_1001 order_amount "5000.00"`

### Step 4: Query the knowledge graph

Now ask questions using natural language concepts:

**Find a person by name:**
```jsonc
// ontology_query
{ "mode": "entities", "classId": "Person", "search": "张三" }
```
Returns: `users_1 (Person) "张三"`

**What orders did this person place?**
```jsonc
// ontology_query
{ "mode": "facts", "subject": "users_1", "predicate": "placed", "includeInferred": true }
```
Returns:
```
users_1 placed orders_1001 (inferred: inverse)
users_1 placed orders_1002 (inferred: inverse)
users_1 placed orders_1003 (inferred: inverse)
```

Note: The database only stores `orders.user_id` (the `placed_by` direction). The reverse `placed` relation is **derived automatically** because we declared `inverseOf`.

**Who supplies these orders?**
```jsonc
// ontology_query
{ "mode": "facts", "subject": "orders_1001", "predicate": "supplied_by" }
```
Returns: `orders_1001 supplied_by suppliers_101`

**Find the path from a person to a supplier:**
```jsonc
// ontology_query
{ "mode": "path", "from": "users_1", "to": "suppliers_101", "depth": 4 }
```
Returns:
```
connected in 2 step(s):
  users_1 placed orders_1001 (inferred: inverse)
  orders_1001 supplied_by suppliers_101
```

**Query the reporting chain (transitive closure):**
```jsonc
// ontology_query
{ "mode": "facts", "subject": "users_4", "predicate": "reports_to", "includeInferred": true }
```
Returns:
```
users_4 reports_to users_2
users_4 reports_to users_1 (inferred: transitive)
```

The database stores only `users_4.manager_id = 2` and `users_2.manager_id = 1`, but the transitive closure gives you the full chain.

### Step 5: Dry-run mode before committing

Before importing production data, preview what would be created:

```jsonc
// ontology_ingest_db
{
  "connection": { /* same as above */ },
  "mapping": { /* same as above */ },
  "options": { "mode": "dry-run", "limit": 2 }
}
```

Returns a preview with sample entities and facts, without writing anything.

### YAML configuration alternative

You can also save the mapping as a YAML file:
```yaml
# ontology-ingest.yml
connection:
  type: postgres
  host: localhost
  database: business
  user: readonly
  password: ${DB_PASSWORD}

mapping:
  tables:
    - table: users
      entityClass: Person
      idColumn: id
      labelColumn: full_name
      attributes:
        - column: email
          relation: has_email
          transform: lowercase
      foreignKeys:
        - column: team_id
          targetTable: teams
          relation: member_of
        - column: manager_id
          targetTable: users
          relation: reports_to
          nullable: true
    # ... other tables
```

Then load it: `cat ontology-ingest.yml | yq -o json | ontology_ingest_db`

## Database import mapping rules

| Database | becomes | Notes |
|---|---|---|
| table | a class you declare | `entityClass` must already exist, or the import refuses before reading a row |
| row | an entity | id is `<table>_<pk>`, or `<prefix>_<table>_<pk>` with `globalPrefix` |
| `labelColumn` | the entity's label | what `ontology_query { mode: "entities", search: "张三" }` matches on |
| foreign key | an entity-valued relation | both sides must already exist as classes |
| other column | a literal-valued relation | needs `rangeKind: "literal"`; NULL values are skipped, not stored as empty strings |
| `where` | a SQL filter | applied per table, for soft deletes and partitions |

Two properties make the round trip worth it:

- **Idempotent.** Re-running an import rewrites the same keys, so a nightly full sync is harmless.
- **Inferable.** The database stores `orders.user_id`; it never stores `users_1 placed orders_1001`. Declare `placed_by` with `inverseOf: placed` and the query engine derives the reverse. A self-referencing foreign key declared `transitive` becomes a whole reporting chain from one hop of stored data.

So the question *"张三的订单是什么，供应商是谁"* is answered by resolving the label to a person, asking for their entailed `placed` edges, and reading `supplied_by` off each order — no hand-written SQL, and the answer comes back as facts carrying `via` so you can see which parts were stored and which were derived.

Ingest runs in three modes: `full`, `incremental` (with a `timestampColumn` and `lastSyncTime`), and `dry-run`, which reports what *would* be written, with sample entities and facts, and touches nothing.

PostgreSQL and MySQL drivers (`pg`, `mysql2`) are optional peer dependencies — install only the one you use:

```sh
pnpm add pg        # PostgreSQL
pnpm add mysql2    # MySQL
```

Rows are read in batches (`batchSize`, default 500) and every write goes through the same validators the tools use, so a `strict` ontology refuses a mapping that would violate it — naming the constraint — rather than importing a broken graph.

## The rules it enforces

**Subsumption.** `subClassOf` is transitive: an entity declared `Service` is also a `Component`, so it satisfies a `Component` domain and is returned by a `Component` query. Cycles are refused at definition time — a cycle would make "is an X" unfalsifiable for every class on it.

**Domain and range.** A relation's `domain` constrains subjects, its `range` constrains objects, both closed under subsumption. An empty list means unconstrained, which is the honest encoding of "not yet decided" rather than a silent allow-all.

**Entity vs literal.** `rangeKind: "literal"` makes a relation attribute-valued (a version string, a date). A literal-valued relation can be neither symmetric, transitive, nor inverted — the derived triple would have a literal in subject position — and that incoherence is refused at definition time rather than producing nonsense later.

**Functional cardinality.** A `functional` relation admits at most one object per subject. A second, different object is a `functional-conflict`, not a silent overwrite. Re-asserting the *same* object stays idempotent.

**Entailment.** `transitive`, `symmetric`, and `inverseOf` are applied to a fixpoint, so the rules compose (the inverse of a transitive relation is itself closed transitively). Entailed facts are **derived on read and never stored** — retract a premise and everything resting on it disappears, with no stale derivation left behind. Each carries `via` naming the rule that produced it.

**Retraction safety.** Retracting an entity cascades to every fact mentioning it. Retracting a *term* is refused while anything still depends on it — a class that still classifies an entity or appears in a relation signature, a relation still asserted — and the refusal names the dependent.

**Redefinition safety.** Redefining a term replaces it wholesale, so the stored facts are re-checked against the would-be vocabulary: narrowing a domain or range, flipping `rangeKind`, adding `functional` over a subject that already has two objects, or cutting a class out of a `subClassOf` chain that facts rely on is refused under `strict`, naming the facts it would break. Under `strict: false` it is applied and the damage is returned as warnings.

**Duplicate guard.** A new entity whose id differs from an existing one only by case, separators, or a `ns:` prefix (`mod:api` beside `api`), or whose label is an existing id, is accepted but comes back with a `possible-duplicate` warning that spells out the merge to run. The store cannot know whether they are one thing, so it says so instead of guessing.

**Merging.** When two ids turn out to name one individual, `ontology_assert` with `merges: [{ from, into }]` rewrites every fact about `from` onto `into`, unions the classes, keeps `into`'s label and comment (filling gaps from `from`), and drops `from`. Rewrites that collide with existing triples collapse; a rewrite that would violate the vocabulary (a `functional` relation seeing two objects) refuses the merge under `strict`.

## Scale

Reads are indexed and memoized per write generation: the first query after a write derives the closure once (a worklist fixpoint over an adjacency index, not a quadratic scan), and every query until the next write reuses it. Writes keep a subject index so a `functional` check costs the subject's degree, not a table scan. On a 21k-entity / 101k-fact synthetic dependency graph (`pnpm bench 20000 3`, Apple Silicon):

| Operation | Before 0.2 | 0.2 |
|---|---|---|
| assert 101k facts in batches of 500 | 340 s | 0.5 s |
| first inferred query after a write | > 6 s at 10k facts | 0.1 s |
| repeated inferred queries | > 6 s each | < 1 ms |
| shortest path, depth 8, inferred | > 6 s | 16 ms |

Entailment stops at `maxInferred` derived facts and says so rather than silently returning a prefix of the closure.

The storage medium is the default `dsh-storage-json` unit (one JSON document per domain, rewritten atomically per write). For graphs in the tens of thousands of facts, override the `storage-json` row in your profile patch with `dsh-storage-sqlite`; the plugin does not care which backend serves its domain.

The prompt section is assembled once per turn by the harness, so vocabulary defined during a turn appears in the standing context from the next turn on.

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
pnpm test        # 124 unit tests: rules, tools, prompt section, ingestion
pnpm typecheck
pnpm build
pnpm smoke       # boot smoke against a real dsh profile (see below)
pnpm bench 2000 3
```

`tests/memory-domain.ts` is an in-memory stand-in for one open storage domain, so the store and the tools are tested end to end — real validation, real entailment, real tool results — without a backend.

`tests/ingest/e2e.spec.ts` is the ingest suite that a mock cannot cover: it runs against real PostgreSQL and MySQL servers, and skips itself when they are absent so a plain `pnpm test` stays hermetic and fast. To run it, `scripts/e2e-databases.sh up` starts both on non-default ports (55432, 33306) and loads `tests/ingest/fixtures/`; `down` removes them. The fixtures carry Chinese labels on purpose — MySQL's client falls back to latin1 without a `--default-character-set`, which is exactly the encoding bug the suite caught in the connector.

`pnpm smoke` is the test the unit suite cannot be. It installs the packed tarball into a fresh dsh profile created from the shipped `headless` template (so `dsh-base` is present), boots it against a scripted local LLM that speaks both wire formats the harness has used, drives `ontology_define` → `ontology_assert` → `ontology_query` with inference, then boots a second time over the same `$DSH_HOME` to check persistence and that the prompt section now carries the vocabulary. No network beyond the npm registry, no API key. `DSH_VERSION` picks the harness (CI runs the oldest supported line and `next`); `DSH_BIN` reuses an installed one; `SMOKE_PLUGIN_SPEC=dsh-ontology@0.1.0` demonstrates that the test catches the duplicate-storage-row boot crash of that release.

## Requirements

- DeepSeek Harness `>= 0.1.5-rc.2` (dsh-base must ship the storage stack)
- Node `^22.19 || >=24`

## License

MIT
