import { assertEquals, assertRejects } from '@std/assert';
import type { RegistryIf } from '../../types.ts';
import { QueueHandle } from '../queue-handle.ts';
import type { QueueEntryId, QueueIO, QueueResourceOptions, QueueStat } from '../types.ts';

const enc = new TextEncoder();

/** A backend holding one entry whose first ack or nack fails, as a dropped connection does. */
function flakyIO() {
  const calls: string[] = [];
  let failures = 1;
  const settle = (verb: string) => (id: QueueEntryId): Promise<void> => {
    calls.push(`${verb} ${id}`);
    if (failures-- > 0) return Promise.reject(new Error('connection terminated unexpectedly'));
    return Promise.resolve();
  };
  const io: QueueIO = {
    append: (data) => {
      calls.push(`append ${JSON.stringify(data)}`);
      return Promise.resolve(2);
    },
    read: () => Promise.resolve({ id: 1, data: { n: 1 }, routingKey: 'evt.test', createdAt: new Date() }),
    ack: settle('ack'),
    nack: settle('nack'),
  };
  return { io, calls };
}

function open(io: QueueIO): QueueHandle {
  const registry = {} as RegistryIf<QueueResourceOptions, QueueStat>;
  return new QueueHandle('q', {}, 'r+', registry, io);
}

Deno.test('a failed ack leaves the entry with the handle, so a nack still reaches it', async () => {
  const { io, calls } = flakyIO();
  const handle = open(io);

  await handle.read(1);
  await assertRejects(() => handle.write(enc.encode('ack\n')), Error, 'connection terminated');
  assertEquals(await handle.write(enc.encode('nack\n')), 0);
  assertEquals(calls, ['ack 1', 'nack 1']);

  await handle.close();
  assertEquals(calls, ['ack 1', 'nack 1']);
});

Deno.test('a failed nack leaves the entry for close to hand back', async () => {
  const { io, calls } = flakyIO();
  const handle = open(io);

  await handle.read(1);
  await assertRejects(() => handle.write(enc.encode('nack\n')), Error, 'connection terminated');
  await handle.close();
  assertEquals(calls, ['nack 1', 'nack 1']);
});
