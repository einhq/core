# Queue Registry

Durable message queue with routing-key based fanout and competing consumers, backed by PostgreSQL.

## Backend

PostgreSQL with LISTEN/NOTIFY for consumer wakeup. No external message broker required.

## Core Concepts

- **Fanout**: Messages published to a routing key are delivered to all queues subscribed to that key.
- **Patterns**: A binding may be a wildcard over the dot-delimited key — `*` is one segment, `#` is zero or more, both as whole segments. `system.vfs.file.*` binds `…file.created` and `…file.updated`; `media.#` binds `media` and everything under it. Semantics live in `src/registries/routing-key-match.ts` and are identical in both backends.
- **Competing consumers**: Multiple handles on the same queue compete for messages. Only one consumer receives each message (`FOR UPDATE SKIP LOCKED`).
- **Ordering**: Within a queue, entries are handed out by delivery id. `append` writes its row
  synchronously. The relay hands each `publish` over on its own macrotask, and PostgreSQL fans out
  what arrived while its last statement ran together, up to 500 messages a statement with ids
  drawn in arrival order, so a write that publishes an event per file costs a statement per batch.
  Do not build a consumer that depends on the order of two routed events.
- **Ack/Nack**: Consumers must acknowledge or reject each message before receiving the next one.
- **Peek**: `peek(id, limit)` lists the first live deliveries in claim order, each `ready` or
  `in-flight` with its attempt count, without locking a row or spending an attempt. Reading a queue
  is a claim, so this is the only way to look at one; `queue-peek` and `head` on a queue node use it
  (through `vfs.queuePeek`), as does the nodes explorer's preview. Dead-lettered deliveries are left
  out; `stat` counts them.
- **Durable**: Messages persist until acknowledged. Unacknowledged messages are automatically nacked on handle close.
- **Dead-lettering**: a delivery may be handed out at most `maxAttempts` times (default 10); past
  that it is marked dead and never claimed again, so a message that can never succeed does not
  come back once a second forever. The count is spent by the **claim**, not by the nack, which is what bounds the crash-loop case too —
  a consumer that dies holding an entry never nacks it, and the lease sweep spends the attempt
  instead. `maxAttempts: 0` restores retry-forever. `deadLetters(id, limit)` lists them and
  `settleDead(id, 'retry' | 'drop', ids?)` hands them out again with no attempts spent, or deletes
  them; `queue-dead` uses both (through `vfs.queueDead` and `vfs.queueSettleDead`).
- **Leases**: a consumer holds an entry for at most `leaseMs` (default 60s). Close is best-effort — a
  killed process never runs it — so an entry whose lease has run out is handed back to the next
  consumer, or dead-lettered if that was its last attempt. Delivery is therefore at-least-once, and
  consumers are written for it. `leaseMs: 0` disables reclaim: a lock then never expires.

```
publish("jobs.index", payload)
       |
       v  fanout to matching queues
  +----+-----+
  v          v
"indexer"  "audit"        <-- touch(name, { routingKeys })
  |          |
+-+-+     +-+-+
C1  C2    C3  C4          <-- open() competing consumers
```

## SQL Schema

```sql
-- Messages (shared across all queues)
CREATE TABLE {prefix}_messages (
  id          BIGSERIAL PRIMARY KEY,
  routing_key TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Queue subscriptions
CREATE TABLE {prefix}_subscriptions (
  id               VARCHAR(26) PRIMARY KEY,
  routing_keys     TEXT[] NOT NULL DEFAULT '{}',
  routing_patterns TEXT[] NOT NULL DEFAULT '{}',  -- compiled regex per wildcard binding
  created_at       TIMESTAMPTZ DEFAULT now()
);
-- GIN index on routing_keys; partial index for rows with patterns

-- Per-delivery tracking
CREATE TABLE {prefix}_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id VARCHAR(26) REFERENCES subscriptions ON DELETE CASCADE,
  message_id      BIGINT REFERENCES messages ON DELETE CASCADE,
  locked_at       TIMESTAMPTZ,  -- NULL = ready, set = locked by consumer
  attempts        INTEGER NOT NULL DEFAULT 0,  -- deliveries handed out, spent by the claim
  dead_at         TIMESTAMPTZ,  -- set = out of attempts, never claimed again
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(subscription_id, message_id)
);
-- Partial index on subscription_id WHERE locked_at IS NULL AND dead_at IS NULL (claim path)
-- Partial index on (subscription_id, locked_at) WHERE NOT NULL                 (lease sweep)
-- Index on message_id                                       (last-delivery check, orphan sweep)
-- NOTIFY trigger on insert
```

A message is deleted with its last delivery. The ack deletes the delivery and checks for the
others in two statements, the check after the delete has committed: a fanned-out message's
consumers ack at nearly the same moment, and in one snapshot each would still see the other's
delivery. A message that is left behind anyway (a subscription deleted while another acks) is
removed by a batched orphan sweep at init and after every `delete` and `truncate`.

## Depth

`stat()` reports the parts separately, and they mean different things:

| Field              | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `size`             | Claimable now — the backlog. This is what a dashboard should show.        |
| `inFlight`         | Held by a consumer, unacked. Not backlog; it is already being worked.     |
| `oldestInFlightMs` | Age of the oldest held entry. Seconds is normal, hours is a bug.          |
| `deadLettered`     | Out of attempts. Neither backlog nor in progress — this work was dropped. |

A single count could not tell a wedged queue from a draining one: rows that are all locked and none
claimable look like backlog. `deadLettered` is separate for the same reason — folding it into
either live number would make a queue holding nothing but poison read as a busy one.

Dead entries stay as rows rather than being deleted: a poison message is the one message worth
looking at, and dropping it silently would leave nothing to explain why the work never happened.
A person retries or drops them (`settleDead`); opening the queue in `w` mode truncates them along
with everything else.

## Sweeping expired leases

The sweep runs only when a claim finds nothing ready, and at most once per lease per queue. Under
load there is always a claimable row and the fast path takes it, so nothing extra runs; the sweep
fires exactly in the state that needs it — nothing claimable, rows still locked.

## Usage

```typescript
const registry = new PgQueueRegistry({
  pool: pgPool,
  name: 'app',
  router: routerManager,
});
await registry.init();

// Create a queue listening to job events
await registry.touch('indexer', { routingKeys: ['jobs.index'] });

// Consumer (blocking read)
const handle = await registry.open('indexer', {}, 'r+');
const ac = new AbortController();

const entry = await handle.read(1, ac.signal); // blocks until message arrives
// entry contains JSON payload

// Acknowledge
await handle.write(new TextEncoder().encode('ack\n'));

// Or reject (re-queues for another consumer, until it runs out of attempts)
// await handle.write(new TextEncoder().encode("nack\n"));

await handle.close(); // auto-nacks any unacknowledged message
```

## Configuration

| Option       | Type            | Description                                                |
| ------------ | --------------- | ---------------------------------------------------------- |
| `pool`       | pg.Pool         | PostgreSQL connection pool                                 |
| `name`       | string          | Prefix for table names                                     |
| `router`     | RouterManagerIf | Event source for routing-key based message delivery        |
| `listenPool` | pg.Pool         | Pool the LISTEN connection is taken from; defaults to pool |

Per-queue options (`touch`/`open`, and queue node attrs):

| Option        | Type     | Default | Description                                               |
| ------------- | -------- | ------- | --------------------------------------------------------- |
| `routingKeys` | string[] | `[]`    | Keys and patterns this queue is bound to                  |
| `leaseMs`     | number   | `60000` | How long a consumer may hold an entry; `0` disables       |
| `maxAttempts` | number   | `10`    | Deliveries before an entry is dead-lettered; `0` disables |

`maxAttempts` is higher than the pool's `3` because a queue has no backoff: the redelivery is
immediate, so the count is the only tolerance a transient failure gets. Three attempts would be
three seconds — short enough to dead-letter on a database blip.
