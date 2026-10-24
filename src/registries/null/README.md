# Null Registry

The registry behind `null` nodes, of which `/dev/null` is the one the boot makes. It holds
nothing: every id exists, a read ends at once with an empty chunk, and a write is accepted whole
and discarded. Being stateless, it needs no backend and is the same on every store.

```typescript
const handle = await new NullRegistry().open('/dev/null', {}, 'r+');
await handle.write(new TextEncoder().encode('gone')); // 4
await handle.read(1024); // Uint8Array(0)
```
