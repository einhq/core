# Buffer Registry

Manages ephemeral in-memory pipe buffers for inter-process communication. Models Linux-like pipes with fixed capacity and async backpressure.

## Backend

In-memory `Map<string, Pipe>`. Data is lost on restart.

## Core Concepts

- **Pipe**: Circular buffer with configurable capacity (default 64KB)
- **Backpressure**: Writers block when the buffer is full, readers block when empty
- **EOF**: Closing a pipe signals EOF to readers; they receive empty bytes when the buffer drains
- **Broken pipe**: `closeRead(id)` says nothing reads the pipe any more. What it holds is dropped,
  and a write to it, waiting or to come, throws bash-executor's `BrokenPipeError`. The shell
  calls it on a pipeline stage's input once the stage ends; a command that then writes gets
  SIGPIPE and ends with 141
- **Zero-capacity**: A pipe with capacity 0 discards all writes immediately

Capacity is a ceiling, not an allocation. A pipe starts with no backing store,
allocates 1KB the first time a writer outruns its reader, doubles from there up
to `capacity`, and releases the store again once it is closed and drained.
`pipe.allocated` reports what it currently holds. Every command gets a stdout
and a stderr pipe and most emit a line or two, so a pipe holds only what it needs.

## Usage

```typescript
const registry = new BufferManager();

// Create a pipe with 1KB capacity
await registry.touch('pipe-1', { capacity: 1024 });

// Writer
const w = await registry.open('pipe-1', {}, 'w');
await w.write(new TextEncoder().encode('hello'));
await w.writeEOF(); // readers see EOF once drained
await w.close();

// Reader
const r = await registry.open('pipe-1', {}, 'r');
const chunk = await r.read(1024); // blocks until data available
await r.close();
```

## Configuration

| Option     | Type   | Default | Description          |
| ---------- | ------ | ------- | -------------------- |
| `capacity` | number | 65536   | Buffer size in bytes |
