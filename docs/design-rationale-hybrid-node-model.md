# Hybrid Node Model: Best of Both Worlds

## Core Concept: Dual-Layer Architecture

```
┌─────────────────────────────────────────────┐
│   Layer 1: Node Abstraction (User-Facing)  │
│   - Unix-like filesystem interface          │
│   - cd, ls, props, attrs commands           │
│   - Everything appears as nodes             │
└─────────────────────────────────────────────┘
                    ↕
┌─────────────────────────────────────────────┐
│   Layer 2: Relational Storage (Optimized)   │
│   - Foreign keys for integrity              │
│   - JOINs for complex queries               │
│   - Indexes for performance                 │
│   - Triggers for consistency                │
└─────────────────────────────────────────────┘
```

**Key Insight:** The node model is the **API**, but the **storage** can be fully relational!

---

## PostgreSQL Schema Design

### Core Tables

```sql
-- 1. Nodes table (props)
CREATE TABLE nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,

  -- Props (Unix-style metadata)
  mode INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  gid INTEGER NOT NULL,
  acl JSONB,

  -- Timestamps
  birth_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  birth_uid INTEGER NOT NULL,
  change_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_uid INTEGER NOT NULL,
  mod_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mod_uid INTEGER NOT NULL,

  -- Version for optimistic locking
  version INTEGER NOT NULL DEFAULT 1,

  -- Indexes
  CONSTRAINT fk_uid FOREIGN KEY (uid) REFERENCES users(id),
  CONSTRAINT fk_gid FOREIGN KEY (gid) REFERENCES groups(id)
);

CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_nodes_uid ON nodes(uid);
CREATE INDEX idx_nodes_gid ON nodes(gid);

-- 2. Node attributes (type-specific data)
CREATE TABLE node_attributes (
  node_id UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  attributes JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_attributes_gin ON node_attributes USING GIN(attributes);

-- 3. Node hierarchy (parent-child relationships)
CREATE TABLE node_hierarchy (
  parent_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  child_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER,  -- Order within parent

  PRIMARY KEY (parent_id, child_id),
  UNIQUE (parent_id, name)  -- Names must be unique within parent
);

CREATE INDEX idx_hierarchy_parent ON node_hierarchy(parent_id);
CREATE INDEX idx_hierarchy_child ON node_hierarchy(child_id);

-- 4. Symlinks (one-way references)
CREATE TABLE symlinks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES nodes(id) ON DELETE SET NULL,
  target_path TEXT,  -- Fallback if target deleted
  label TEXT,

  CONSTRAINT fk_source FOREIGN KEY (source_id) REFERENCES nodes(id),
  CONSTRAINT fk_target FOREIGN KEY (target_id) REFERENCES nodes(id)
);

CREATE INDEX idx_symlinks_source ON symlinks(source_id);
CREATE INDEX idx_symlinks_target ON symlinks(target_id);

-- 5. Relations (bidirectional relationships)
CREATE TABLE relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_a UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_b UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label_a TEXT NOT NULL,  -- "partner", "parent", "sibling"
  label_b TEXT NOT NULL,  -- "partner", "child", "sibling"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_node_a FOREIGN KEY (node_a) REFERENCES nodes(id),
  CONSTRAINT fk_node_b FOREIGN KEY (node_b) REFERENCES nodes(id),
  CONSTRAINT no_self_relation CHECK (node_a != node_b),
  CONSTRAINT ordered_nodes CHECK (node_a < node_b)  -- Prevent duplicates
);

CREATE INDEX idx_relations_node_a ON relations(node_a);
CREATE INDEX idx_relations_node_b ON relations(node_b);

-- 6. Users and Groups
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_groups (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- 7. Embeddings (for face recognition, similarity search)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  embedding_type TEXT NOT NULL,  -- "face", "image", "text"
  embedding vector(512),  -- Adjust dimensions as needed
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_node FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX idx_embeddings_node ON embeddings(node_id);
CREATE INDEX idx_embeddings_type ON embeddings(embedding_type);
CREATE INDEX idx_embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops);
```

---

## How the Node Model Maps to Relational

### Node Read Operation

```typescript
// User command: ls /people
// What user sees: node-based view

async function getNode(id: string): Promise<Node> {
  // Single query with JOIN
  const result = await db.query(
    `
    SELECT
      n.*,
      a.attributes,
      json_agg(
        json_build_object('id', h.child_id, 'name', h.name)
        ORDER BY h.position
      ) FILTER (WHERE h.child_id IS NOT NULL) as children
    FROM nodes n
    LEFT JOIN node_attributes a ON n.id = a.node_id
    LEFT JOIN node_hierarchy h ON n.id = h.parent_id
    WHERE n.id = $1
    GROUP BY n.id, a.attributes
  `,
    [id],
  );

  // Transform to node structure
  return {
    _id: result.id,
    type: result.type,
    props: {
      mode: result.mode,
      uid: result.uid,
      gid: result.gid,
      acl: result.acl,
      btime: { uid: result.birth_uid, timestamp: result.birth_time },
      ptime: { uid: result.change_uid, timestamp: result.change_time },
      atime: { uid: result.mod_uid, timestamp: result.mod_time },
      children: result.children || [],
      count: result.children?.length || 0,
      version: result.version,
    },
    attrs: result.attributes,
  };
}
```

**Benefits:**

- ✅ User sees same node structure
- ✅ Single efficient JOIN query
- ✅ Database maintains referential integrity
- ✅ CASCADE deletes work automatically

---

## Key Advantages of This Hybrid Approach

### 1. Referential Integrity with CASCADE

```sql
-- Delete a person node
DELETE FROM nodes WHERE id = 'person-123';

-- PostgreSQL automatically:
-- 1. Removes from node_hierarchy (CASCADE)
-- 2. Removes node_attributes (CASCADE)
-- 3. Removes relations (CASCADE)
-- 4. Removes embeddings (CASCADE)
-- 5. Updates symlinks (SET NULL)
```

**No manual cleanup needed!** Database guarantees consistency.

---

### 2. Efficient Complex Queries

#### Find all photos with a specific person

```sql
-- Direct JOIN - much faster than app-level iteration!
SELECT
  photos.id,
  photos.attributes->>'filepath' as filepath,
  photos.attributes->>'timestamp' as timestamp
FROM nodes photos
JOIN node_attributes photo_attrs ON photos.id = photo_attrs.node_id
JOIN node_hierarchy photo_people ON photos.id = photo_people.parent_id
WHERE photos.type = 'file'
  AND photo_attrs.attributes->>'mimetype' LIKE 'image/%'
  AND photo_people.child_id = $person_id
ORDER BY photo_attrs.attributes->>'timestamp' DESC;
```

**Benefits:**

- ✅ Single query (not N+1)
- ✅ Database does heavy lifting
- ✅ Optimized with indexes
- ✅ User still sees node structure

---

### 3. Family Tree Queries with Recursive CTEs

```sql
-- Find all ancestors of a person
WITH RECURSIVE ancestry AS (
  -- Base case: start with person
  SELECT
    r.node_b as person_id,
    r.node_a as parent_id,
    r.label_b as relationship,
    1 as generation,
    ARRAY[r.node_b, r.node_a] as path
  FROM relations r
  WHERE r.node_b = $person_id
    AND r.label_a = 'parent'

  UNION ALL

  -- Recursive case: find parents of parents
  SELECT
    a.person_id,
    r.node_a as parent_id,
    r.label_b as relationship,
    a.generation + 1,
    a.path || r.node_a
  FROM ancestry a
  JOIN relations r ON r.node_b = a.parent_id
  WHERE r.label_a = 'parent'
    AND NOT (r.node_a = ANY(a.path))  -- Prevent cycles
)
SELECT DISTINCT
  n.id,
  n.attributes->>'fullname' as name,
  a.generation,
  a.relationship
FROM ancestry a
JOIN nodes n ON n.id = a.parent_id
ORDER BY a.generation;
```

**Benefits:**

- ✅ Database traverses tree efficiently
- ✅ Handles cycles automatically
- ✅ Much faster than app-level recursion
- ✅ User still interacts via node commands

---

### 4. Relationship Path Computation

```sql
-- How am I related to person X?
WITH RECURSIVE relationship_path AS (
  -- Direct relationships
  SELECT
    node_a as from_id,
    node_b as to_id,
    label_b as relationship,
    1 as distance,
    ARRAY[node_a, node_b] as path,
    ARRAY[label_b] as labels
  FROM relations
  WHERE node_a = $person_a

  UNION ALL

  -- Indirect relationships
  SELECT
    rp.from_id,
    r.node_b as to_id,
    r.label_b as relationship,
    rp.distance + 1,
    rp.path || r.node_b,
    rp.labels || r.label_b
  FROM relationship_path rp
  JOIN relations r ON r.node_a = rp.to_id
  WHERE rp.distance < 10  -- Limit depth
    AND NOT (r.node_b = ANY(rp.path))
)
SELECT * FROM relationship_path
WHERE to_id = $person_b
ORDER BY distance
LIMIT 1;
```

**Result:** "Second cousin once removed" computed by database!

---

### 5. Multi-Dimensional Queries

```sql
-- "All photos with Anna in Göteborg during 2018"
SELECT DISTINCT
  photos.id,
  photo_attrs.attributes->>'filepath' as filepath,
  photo_attrs.attributes->>'timestamp' as timestamp
FROM nodes photos
JOIN node_attributes photo_attrs ON photos.id = photo_attrs.node_id
-- Person filter
JOIN node_hierarchy photo_people ON photos.id = photo_people.parent_id
JOIN nodes people ON people.id = photo_people.child_id
JOIN node_attributes person_attrs ON people.id = person_attrs.node_id
-- Location filter
JOIN node_hierarchy photo_locations ON photos.id = photo_locations.parent_id
JOIN nodes locations ON locations.id = photo_locations.child_id
JOIN node_attributes loc_attrs ON locations.id = loc_attrs.node_id
WHERE photos.type = 'file'
  AND photo_attrs.attributes->>'mimetype' LIKE 'image/%'
  -- Anna
  AND person_attrs.attributes->>'fullname' = 'Anna'
  -- Göteborg
  AND loc_attrs.attributes->>'name' ILIKE '%Göteborg%'
  -- 2018
  AND EXTRACT(YEAR FROM (photo_attrs.attributes->>'timestamp')::timestamptz) = 2018
ORDER BY photo_attrs.attributes->>'timestamp';
```

**Benefits:**

- ✅ Complex multi-dimensional query in SQL
- ✅ Database optimizes JOIN order
- ✅ Fast with proper indexes
- ✅ User still sees results as nodes

---

### 6. Vector Similarity with Joins

```sql
-- Find photos with similar faces to this person
SELECT
  photos.id,
  photo_attrs.attributes->>'filepath' as filepath,
  e.embedding <=> $query_embedding as similarity
FROM embeddings e
JOIN nodes photos ON e.node_id = photos.id
JOIN node_attributes photo_attrs ON photos.id = photo_attrs.node_id
WHERE e.embedding_type = 'face'
  AND e.embedding <=> $query_embedding < 0.5  -- Similarity threshold
ORDER BY similarity
LIMIT 20;
```

**Benefits:**

- ✅ Vector similarity + relational data in one query
- ✅ pgvector HNSW index for fast search
- ✅ No separate vector database needed

---

## The Node API Layer

### User Interface (Unchanged)

```bash
# User still uses node-based commands
$ cd /people/anna
$ ls
photos/
events/
relationships/

$ props .
type: person
mode: 0755
uid: 1000
gid: 1000
...

$ attrs .
{
  "fullname": "Anna Johnson",
  "birthdate": "1985-03-15",
  "biography": "..."
}

# But under the hood: optimized SQL with JOINs!
```

---

### Optimized Functions "Beside" the Node API

```typescript
// High-level node API (for users/terminal)
export const nodeAPI = {
  getNode(id: string): Promise<Node>,
  listChildren(id: string): Promise<Node[]>,
  createNode(parent: string, type: string, attrs: any): Promise<Node>,
  // ... etc
};

// Optimized relational API (for internal/complex operations)
export const relationAPI = {
  // Bypass node abstraction for performance
  async findPhotosByPersonAndLocation(
    personId: string,
    locationName: string,
    year: number
  ): Promise<Photo[]> {
    // Direct SQL with JOINs
    return db.query(`/* complex JOIN query */`);
  },

  async computeRelationshipPath(
    personA: string,
    personB: string
  ): Promise<RelationshipPath> {
    // Recursive CTE
    return db.query(`/* recursive query */`);
  },

  async findSimilarFaces(
    embedding: number[],
    threshold: number
  ): Promise<Face[]> {
    // pgvector similarity
    return db.query(`/* vector search */`);
  },

  // These return node-compatible data but use SQL internally!
};
```

**Principle:**

- Simple operations → Node API (abstraction)
- Complex operations → Direct SQL (performance)
- Both return same node structure to user

---

## Maintaining Node Abstraction Consistency

### Option 1: Denormalized Cache (Recommended)

```sql
-- Add materialized children to nodes table
ALTER TABLE nodes ADD COLUMN children_cache JSONB;

-- Update via trigger
CREATE OR REPLACE FUNCTION update_children_cache()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE nodes
  SET children_cache = (
    SELECT json_agg(json_build_object('id', child_id, 'name', name))
    FROM node_hierarchy
    WHERE parent_id = COALESCE(NEW.parent_id, OLD.parent_id)
  )
  WHERE id = COALESCE(NEW.parent_id, OLD.parent_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hierarchy_changed
AFTER INSERT OR UPDATE OR DELETE ON node_hierarchy
FOR EACH ROW EXECUTE FUNCTION update_children_cache();
```

**Benefits:**

- ✅ Fast node retrieval (no JOIN needed)
- ✅ Still use JOINs for complex queries
- ✅ Trigger keeps cache in sync
- ✅ Best of both worlds!

---

### Option 2: Computed on Read

```typescript
// Always JOIN when reading nodes
async function getNode(id: string): Promise<Node> {
  // ... query with LEFT JOIN node_hierarchy
}
```

**Trade-off:**

- ⚠️ Slightly slower single-node reads
- ✅ No cache to maintain
- ✅ Always consistent

---

## Migration Strategy: Gradual Optimization

### Phase 1: Direct Port

```typescript
// Port MongoDB model 1:1 to PostgreSQL
// Children stored in JSONB like MongoDB
```

### Phase 2: Add Hierarchy Table

```sql
-- Add node_hierarchy table
-- Populate from children JSONB
-- Keep both in sync with triggers
```

### Phase 3: Optimize Queries

```typescript
// Add optimized relation API functions
// Use JOINs for complex queries
// Keep node API unchanged
```

### Phase 4: Remove JSONB Children

```sql
-- Remove children from JSONB
-- Fully relational hierarchy
-- Compute children on read
```

**Benefit:** Gradual migration, always working system!

---

## Real-World Example: Face Recognition Workflow

```typescript
// 1. User uploads photo (node API)
const photo = await nodeAPI.createNode('/photos', 'file', {
  filepath: '/media/photo.jpg',
  mimetype: 'image/jpeg'
});

// 2. Background worker processes (optimized API)
const faces = await detectFaces(photo.attrs.filepath);

for (const face of faces) {
  // Create face node
  const faceNode = await nodeAPI.createNode(photo._id, 'face', {
    bounds: face.bounds
  });

  // Store embedding (relational + vector)
  await db.query(`
    INSERT INTO embeddings (node_id, embedding_type, embedding)
    VALUES ($1, 'face', $2)
  `, [faceNode._id, face.embedding]);
}

// 3. Find matching person (optimized API with vector search)
const matches = await relationAPI.findSimilarFaces(
  face.embedding,
  0.5  // threshold
);

// 4. User sees results as nodes
$ ls /photos/photo123/faces/
face-1  (matched: anna)
face-2  (unknown)
```

**Flow:**

- Node API for structure (user-friendly)
- Relational API for performance (database-optimized)
- User never sees the complexity!

---

## Comparison: Hybrid vs Pure Models

| Feature                   | Pure Node (MongoDB) | Hybrid (PostgreSQL) | Pure Relational  |
| ------------------------- | ------------------- | ------------------- | ---------------- |
| **User Interface**        | ✅ Clean            | ✅ Clean            | ❌ Complex       |
| **Simple Queries**        | ✅ Fast             | ✅ Fast             | ⚠️ Need JOINs    |
| **Complex Queries**       | ⚠️ App code         | ✅ SQL JOINs        | ✅ SQL JOINs     |
| **Referential Integrity** | ❌ Manual           | ✅ Automatic        | ✅ Automatic     |
| **Vector Search**         | ⚠️ External DB      | ✅ Integrated       | ✅ Integrated    |
| **Family Tree**           | ⚠️ App recursion    | ✅ Recursive CTE    | ✅ Recursive CTE |
| **Data Integrity**        | ⚠️ App logic        | ✅ Constraints      | ✅ Constraints   |
| **Performance**           | ✅ Good             | ✅ Excellent        | ✅ Excellent     |

---

## Conclusion: Best of Both Worlds! 🎉

**Yes! You can have the node model AND PostgreSQL's relational strengths!**

### The Key Principles:

1. **Node API = User Interface**
   - Commands like `ls`, `cd`, `props`, `attrs`
   - Simple, intuitive, Unix-like
   - Users never see SQL

2. **Relational Storage = Implementation**
   - Foreign keys for integrity
   - JOINs for performance
   - Triggers for consistency
   - Indexes for speed

3. **Dual Access Pattern**
   - Simple operations → Node API
   - Complex operations → Optimized SQL
   - Both return node-compatible data

### This Gives You:

✅ Clean user interface (node-based)
✅ Database integrity (foreign keys, CASCADE)
✅ High performance (JOINs, indexes)
✅ Vector search (pgvector)
✅ Complex queries (recursive CTEs)
✅ Maintainability (constraints)

### Next Steps:

Would you like me to:

1. **Design the complete PostgreSQL schema** with all node types?
2. **Create migration plan** from current MongoDB to hybrid model?
3. **Build the abstraction layer** (node API + optimized API)?
4. **Start implementing Phase 2** with this hybrid approach?

This is the best solution - you get PostgreSQL's power while keeping the elegant node abstraction! 🚀
