# Router Registry

In-memory pub/sub router. Resources are subscriptions bound to a routing key. Writing fans out raw data to all active readers on the same routing key. No buffering or encoding.

A key may be a wildcard pattern (`system.vfs.#`, `src/registries/routing-key-match.ts`), which makes the node a **read-only tail**: it receives everything published on any key the pattern covers, and a write to it fails with `cannot publish to a routing key pattern: …`. That asymmetry is the point — a router node's key is normally also what its writes publish _to_, and a pattern says which keys to listen to, not which one to publish on.

Every published message in the instance reaches the relay handler, so an exact key is one map lookup and patterns live in a second map that is empty unless a pattern node is being read.

## Interfaces

`RouterRegistry` implements `RouterRegistryIf`, a `RegistryIf` for routes, plus `publish(routingKey, payload)`. Publishing and the relay underneath it are the router manager's (`RouterManagerIf`), which the registry is constructed with.

## Usage

```typescript
const router = new RouterRegistry({ router: routerManager });
await router.init();

// create a route
await router.touch('my-sub', { routingKey: 'events' });

// read side -- blocks until data arrives
const reader = await router.open('my-sub', { routingKey: 'events' }, 'r');
const data = await reader.read(0, signal); // blocks until publish

// a pattern node tails every key it covers; reads only
await router.touch('vfs-tail', { routingKey: 'system.vfs.#' });
const tail = await router.open('vfs-tail', { routingKey: 'system.vfs.#' }, 'r');

// write side -- fans out to all readers on this routing key
const writer = await router.open('my-sub', { routingKey: 'events' }, 'w');
await writer.write(new TextEncoder().encode('hello'));
```

## Global consumers

Global consumers of the router manager receive all published messages regardless of routing key. The queue, log and track registries relay through one each.

```typescript
const unsub = routerManager.on(async (routingKey, payload) => {
  // handle event
});

routerManager.publish('events', { type: 'created' });

unsub(); // unsubscribe
```
