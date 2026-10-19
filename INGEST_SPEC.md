# Database Ingest Layer Specification

## Overview

This specification describes the database ingestion layer for `dsh-ontology`, enabling automatic import of entities and relations from relational databases (MySQL and PostgreSQL) into the ontology knowledge graph.

## Goals

1. **Automatic Data Import**: Transform database tables into ontology entities and facts
2. **Foreign Key Mapping**: Convert database foreign keys into typed ontology relations
3. **Type Safety**: Maintain all existing ontology constraints during import
4. **Incremental Sync**: Support both full and incremental data synchronization
5. **Zero Breaking Changes**: Fully backward compatible with existing dsh-ontology API

## Non-Goals

- Real-time change data capture (CDC)
- Bidirectional sync (ontology → database writes)
- Support for NoSQL databases (Phase 2)
- Automatic schema inference without user configuration (Phase 2)

## Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent (DSH Runtime)                      │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴──────────────┐
        │                               │
        ▼                               ▼
┌───────────────┐              ┌────────────────┐
│ Original      │              │ New Ingest     │
│ Tools         │              │ Tools          │
│ (unchanged)   │              │ (new)          │
└───────┬───────┘              └────────┬───────┘
        │                               │
        │    ┌──────────────────────────┘
        │    │
        ▼    ▼
┌─────────────────────────────────────────────────────────────┐
│              OntologyStore (unchanged)                       │
│         Constraint Validation + Persistence                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│           Ontology Engine (unchanged)                        │
│      Pure reasoning: entail, validate, query                 │
└─────────────────────────────────────────────────────────────┘
```

### Module Structure

```
src/ingest/
├── index.ts           # Tool registration + public API
├── types.ts           # Type definitions
├── engine.ts          # Core orchestration logic
├── transformer.ts     # Row → Entity/Fact conversion
├── validator.ts       # Mapping validation
├── utils.ts           # Utilities (ID generation, env vars)
└── connectors/
    ├── base.ts        # Connector interface
    ├── factory.ts     # Connector factory
    ├── postgres.ts    # PostgreSQL implementation
    └── mysql.ts       # MySQL implementation
```

## API Design

### Tool: `ontology_ingest_db`

**Description**: Import entities and relations from a relational database using foreign key relationships.

**Input Schema**:

```typescript
{
  connection: {
    type: 'mysql' | 'postgres'
    host: string
    port?: number                    // default: 3306 (MySQL) / 5432 (PostgreSQL)
    database: string
    user: string
    password: string                 // supports ${ENV_VAR} syntax
    ssl?: boolean | object
    connectionTimeout?: number       // milliseconds, default: 10000
  }
  
  mapping: {
    globalPrefix?: string            // e.g., "prod" → "prod_users_1"
    tables: [
      {
        table: string                // table name
        entityClass: string          // ontology class to map to
        idColumn: string             // primary key column
        labelColumn?: string         // column to use as entity label
        commentColumn?: string       // column to use as entity comment
        
        attributes?: [               // regular columns → literal relations
          {
            column: string
            relation: string         // ontology relation name
            transform?: 'lowercase' | 'uppercase' | 'trim'
          }
        ]
        
        foreignKeys?: [              // foreign keys → entity relations
          {
            column: string           // FK column name
            targetTable: string      // referenced table
            relation: string         // ontology relation name
            nullable?: boolean       // allow NULL values (default: true)
          }
        ]
        
        where?: string               // SQL WHERE clause filter
        entityIdTemplate?: string    // custom ID template, e.g., "${table}_${id}_v2"
      }
    ]
  }
  
  options?: {
    mode?: 'full' | 'incremental' | 'dry-run'  // default: 'full'
    batchSize?: number               // rows per batch, default: 500
    limit?: number                   // max rows to import (for testing)
    timestampColumn?: string         // for incremental sync
    lastSyncTime?: string            // ISO 8601 timestamp
    continueOnError?: boolean        // default: false
  }
}
```

**Output Schema**:

```typescript
{
  success: boolean
  mode: 'full' | 'incremental' | 'dry-run'
  
  stats: {
    tablesProcessed: number
    entitiesCreated: number
    factsCreated: number
    rowsSkipped: number
    duration: number                 // milliseconds
  }
  
  tables: [
    {
      table: string
      rowsRead: number
      entitiesCreated: number
      factsCreated: number
      errors: number
      warnings: number
      duration: number
    }
  ]
  
  errors: [
    {
      table: string
      row?: number
      type: 'connection' | 'validation' | 'constraint' | 'mapping' | 'transform'
      message: string
      detail?: any
    }
  ]
  
  warnings: [
    {
      table: string
      type: 'null-fk' | 'missing-label' | 'duplicate-id' | 'type-mismatch'
      message: string
      count?: number
      examples?: string[]
    }
  ]
  
  preview?: {                        // only in dry-run mode
    wouldCreateEntities: number
    wouldCreateFacts: number
    sampleEntities: Array<{ id: string; classes: string[]; label?: string }>
    sampleFacts: Array<{ subject: string; predicate: string; object: string }>
  }
}
```

### Tool: `ontology_ingest_from_config`

**Description**: Import data using a YAML configuration file.

**Input Schema**:

```typescript
{
  configPath: string               // path to YAML config file
  overrides?: {                    // override specific config values
    connection?: Partial<ConnectionConfig>
    options?: Partial<IngestOptions>
  }
}
```

**Output Schema**: Same as `ontology_ingest_db`

## Configuration File Format

```yaml
# ontology-ingest.config.yml

connection:
  type: postgres
  host: localhost
  port: 5432
  database: myapp
  user: postgres
  password: ${DB_PASSWORD}           # environment variable support

mapping:
  globalPrefix: prod                 # optional
  tables:
    - table: users
      entityClass: Person
      idColumn: id
      labelColumn: full_name
      commentColumn: bio
      
      attributes:
        - column: email
          relation: has_email
        - column: phone
          relation: has_phone
          transform: trim
      
      foreignKeys:
        - column: team_id
          targetTable: teams
          relation: member_of
          nullable: true
        
        - column: manager_id
          targetTable: users           # self-reference supported
          relation: reports_to
          nullable: true
    
    - table: teams
      entityClass: Team
      idColumn: id
      labelColumn: name
      where: "deleted_at IS NULL"      # only import active teams
    
    - table: orders
      entityClass: Order
      idColumn: id
      labelColumn: order_number
      
      attributes:
        - column: amount
          relation: order_amount
        - column: status
          relation: order_status
      
      foreignKeys:
        - column: user_id
          targetTable: users
          relation: placed_by
        - column: supplier_id
          targetTable: suppliers
          relation: supplied_by

options:
  mode: incremental
  timestampColumn: updated_at
  batchSize: 500
  continueOnError: false
```

## Data Transformation Rules

### Entity ID Generation

**Default Template**: `{table}_{id}`

Examples:
- `users.id=1` → `users_1`
- `orders.id=1001` → `orders_1001`

**With Global Prefix**: `{prefix}_{table}_{id}`

Examples:
- `users.id=1` with prefix "prod" → `prod_users_1`

**Custom Template**: `{entityIdTemplate}`

Variables available:
- `${table}` - table name
- `${id}` - primary key value
- `${prefix}` - global prefix (if set)

Example: `"user_${id}_v2"` → `user_1_v2`

### Label Resolution

Priority order:
1. `labelColumn` if specified
2. First non-id string column
3. `id` column value as fallback

### NULL Foreign Key Handling

- If `nullable: true` (default): Skip the fact, add warning
- If `nullable: false`: Reject the row, add error

### Batch Processing

- Fetch rows in batches of `batchSize` (default 500)
- Transform each batch
- Call `ontology_assert` per batch
- Accumulate statistics

### Incremental Sync

When `mode: incremental`:

1. Check `timestampColumn` exists
2. Fetch only rows where `timestamp > lastSyncTime`
3. Import as usual
4. Return new `lastSyncTime` for next run

## Constraint Validation

All existing ontology constraints are enforced:

1. **Domain Check**: Entity's class must match relation's domain
2. **Range Check**: Object's class must match relation's range
3. **Functional Check**: Only one value per subject for functional relations
4. **ID Format**: Must match `/^[A-Za-z_][A-Za-z0-9_.:-]*$/`

Violations in `strict: true` mode → reject entire batch  
Violations in `strict: false` mode → store with violations recorded

## Error Handling

### Connection Errors
- Database unreachable
- Authentication failure
- Network timeout

Action: Fail fast, return error, no partial import

### Validation Errors
- Table/column doesn't exist
- Invalid mapping configuration
- Incompatible data types

Action: Fail before any data import

### Constraint Errors
- Domain/range violation
- Functional conflict
- Invalid entity ID

Action: Skip row (if `continueOnError: true`), or abort batch

### Transform Errors
- JSON parse failure
- Type conversion error

Action: Skip field, add warning

## Testing Strategy

### Unit Tests

1. **Transformer Tests** (`transformer.spec.ts`)
   - Row → Entity conversion
   - Row → Fact conversion
   - FK mapping
   - NULL handling
   - Custom ID templates

2. **Validator Tests** (`validator.spec.ts`)
   - Mapping validation
   - Schema introspection
   - Configuration parsing

3. **Connector Tests** (`postgres.spec.ts`, `mysql.spec.ts`)
   - Connection lifecycle
   - Query execution
   - Schema introspection
   - Error handling

### Integration Tests

Using Testcontainers or Docker Compose:

1. Spin up PostgreSQL/MySQL container
2. Load test schema and data
3. Define ontology
4. Run ingest
5. Verify entities and facts created
6. Query and validate inference

### Smoke Test

Add to existing `pnpm smoke`:

1. Create test database
2. Load sample data (users, teams, orders)
3. Run ingest tool via DSH agent
4. Query: "Who are all the users?"
5. Query: "What teams does user_1 belong to?"
6. Verify results

## Migration Path

### Phase 1: Core Implementation (This PR)
- [x] Spec document
- [x] Type definitions
- [x] Database connectors (PostgreSQL, MySQL)
- [x] Transformer logic
- [x] Validator logic
- [x] Core engine
- [x] Tool registration
- [x] Unit tests
- [x] Integration tests (`tests/ingest/e2e.spec.ts`, real servers)
- [x] Documentation

### Phase 2: Enhancements (Future)
- [ ] Automatic schema inference (`ontology_suggest_from_db`)
- [ ] More databases (SQLite, Oracle, SQL Server)
- [ ] Change data capture (CDC) integration
- [ ] Bidirectional sync
- [ ] Schema evolution tracking
- [ ] Performance optimization (parallel batches)

## Backward Compatibility

✅ **Zero Breaking Changes**

- All existing tools unchanged
- No modifications to `OntologyStore` API
- No changes to reasoning engine
- Ingest layer is opt-in (can be disabled)
- Pure additive changes

## Dependencies

**New Peer Dependencies**:

```json
{
  "peerDependencies": {
    "pg": "^8.11.0",
    "mysql2": "^3.6.0"
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true },
    "mysql2": { "optional": true }
  }
}
```

Users install only what they need:

```bash
# PostgreSQL users
pnpm add pg

# MySQL users
pnpm add mysql2
```

**New Dev Dependencies** (for testing):

```json
{
  "devDependencies": {
    "testcontainers": "^10.0.0",
    "pg": "^8.11.0",
    "mysql2": "^3.6.0"
  }
}
```

## Security Considerations

1. **Credential Storage**: Never commit passwords; use env vars
2. **SQL Injection**: All user inputs are parameterized
3. **Connection Limits**: Respect database connection pools
4. **SSL/TLS**: Support encrypted connections
5. **Read-Only**: Ingest layer only reads from database

## Performance Characteristics

### Expected Performance

- **Small datasets** (<10K rows): <5 seconds
- **Medium datasets** (10K-100K rows): 30-120 seconds
- **Large datasets** (>100K rows): Consider batching or incremental sync

### Bottlenecks

1. Network latency (database queries)
2. Ontology constraint validation
3. Storage writes

### Optimization Strategies

1. Batch processing (default: 500 rows)
2. Incremental sync for large tables
3. Memoized constraint checks (reuse existing optimization)
4. Connection pooling (future)

## Example Usage Scenarios

### Scenario 1: Initial Import

```typescript
// User tells agent: "Import our user and team data from the production database"

await tools.ontology_ingest_db({
  connection: {
    type: 'postgres',
    host: 'prod-db.company.com',
    database: 'myapp',
    user: 'readonly',
    password: process.env.DB_PASSWORD
  },
  mapping: {
    globalPrefix: 'prod',
    tables: [
      {
        table: 'users',
        entityClass: 'Person',
        idColumn: 'id',
        labelColumn: 'name',
        foreignKeys: [
          { column: 'team_id', targetTable: 'teams', relation: 'member_of' }
        ]
      },
      {
        table: 'teams',
        entityClass: 'Team',
        idColumn: 'id',
        labelColumn: 'name'
      }
    ]
  },
  options: { mode: 'full', limit: 1000 }
})
```

### Scenario 2: Incremental Sync

```typescript
// Run daily to sync new/updated records

await tools.ontology_ingest_db({
  connection: { /* ... */ },
  mapping: { /* ... */ },
  options: {
    mode: 'incremental',
    timestampColumn: 'updated_at',
    lastSyncTime: '2026-10-15T00:00:00Z'
  }
})
```

### Scenario 3: Dry Run Preview

```typescript
// User: "Show me what would be imported from the users table"

const result = await tools.ontology_ingest_db({
  connection: { /* ... */ },
  mapping: { /* ... */ },
  options: { mode: 'dry-run', limit: 10 }
})

console.log(result.preview.sampleEntities)
// [{ id: 'users_1', classes: ['Person'], label: 'Alice' }, ...]
```

### Scenario 4: Natural Language Query After Import

```
User: "张三的订单是什么，供应商是谁？"

Agent reasoning:
1. Query: ontology_query({ mode: 'entities', class: 'Person', text: '张三' })
   → Found: users_3
2. Query: ontology_query({ mode: 'facts', subject: 'users_3', predicate: 'has_order' })
   → Found: orders_1001, orders_1002
3. Query: ontology_query({ mode: 'facts', subject: 'orders_1001', predicate: 'supplied_by' })
   → Found: suppliers_101
4. Query: ontology_query({ mode: 'entities', ids: ['suppliers_101'] })
   → Label: "阿里云供应商"

Agent response: "张三有2个订单：ORD-2026-001（供应商：阿里云供应商）..."
```

## Open Questions

1. **Should we support composite primary keys?**
   - Proposal: Use `${id1}_${id2}` format
   - Decision: Phase 2

2. **How to handle many-to-many junction tables?**
   - Proposal: Detect junction tables and create direct relations
   - Decision: Phase 2 (for now, import as entities)

3. **Should we auto-create inverse relations?**
   - Proposal: If `inverseOf` defined in ontology, auto-assert both directions
   - Decision: Yes, but requires ontology definition first

4. **Rate limiting for large databases?**
   - Proposal: Add `delayBetweenBatches` option
   - Decision: Phase 2

## References

- [Original dsh-ontology README](./README.md)
- [Ontology reasoning core](./src/ontology.ts)
- [DSH Tool API](https://github.com/deepseek-ai/deepseek-harness)
- [PostgreSQL INFORMATION_SCHEMA](https://www.postgresql.org/docs/current/information-schema.html)
- [MySQL INFORMATION_SCHEMA](https://dev.mysql.com/doc/refman/8.0/en/information-schema.html)

---

**Document Version**: 1.0  
**Date**: 2026-10-16  
**Status**: Implemented

## Implementation Notes

Built as specified, with these decisions settled during implementation:

- **`ontology_ingest_from_config` is not included.** The tool takes the mapping
  as structured arguments, which is what an agent produces anyway, and a
  file-reading path would have added a second way to express the same thing.
  The YAML in `examples/` documents the shape rather than being a second entry
  point.
- **Warnings and errors are capped, not streaming.** `MAX_REPORTED_ERRORS`
  bounds the per-row errors a run returns, so one systemic mistake (a wrong
  `entityClass`) does not return 20,000 entries; the count is still in the
  per-table result.
- **The MySQL connection pins `charset: 'utf8mb4'`.** A server whose defaults
  are latin1 silently mangles non-ASCII labels on the way in. Found by the
  end-to-end suite, which is why the fixtures use Chinese labels.
- **Drivers are loaded with a dynamic `import()` inside `connect()`, not at
  module scope.** A static `import pg` would be pulled in by every profile
  that lists the plugin, making a driver mandatory for someone who only wants
  the core tools — and against an optional peer dependency, it would crash at
  boot. The failure is now deferred to the call that needs it, where it reads
  as an install instruction.
- **Composite primary keys and junction tables are out of scope**, as
  planned — a composite key would need an id template to be expressible.
