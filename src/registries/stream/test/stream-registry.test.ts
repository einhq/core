/**
 * A stream carries its writer's bytes to every reader from the moment it joined, its header first,
 * or from the latest start point its writer marked;
 * a reader waits for bytes and for a writer, ends with the writer, and is let go when it falls
 * behind, never holding the writer; one writer at a time; `wanted` follows the readers, with a grace.
 * A picture stream gives each reader one whole picture, the latest while it is fresh, and is wanted
 * only while a reader waits for one.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { isStreamWriter, StreamRegistry, type StreamWriter } from '../mod.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Everything `reader` holds now and until its end. */
const readAll = async (reader: { read(size: number): Promise<Uint8Array> }): Promise<string> => {
  let out = '';
  for (let chunk = await reader.read(1024); chunk.length > 0; chunk = await reader.read(1024)) out += text(chunk);
  return out;
};

Deno.test('StreamRegistry', async (t) => {
  await t.step('a reader gets what is written from when it joined, its header first', async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const writer = await registry.open('s', {}, 'w');
    assert(isStreamWriter(writer));
    await writer.write(bytes('before anyone '));
    const early = await registry.open('s', {}, 'r');
    await writer.writeHeader(bytes('[header] '));
    await writer.write(bytes('one '));
    const late = await registry.open('s', {}, 'r');
    await writer.write(bytes('two'));
    await writer.close();
    assertEquals(await readAll(early), '[header] one two');
    assertEquals(await readAll(late), '[header] two');
    await early.close();
    await late.close();
  });

  await t.step('a reader joins at the latest start point, after the header', async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const writer = await registry.open('s', {}, 'w') as StreamWriter;
    await writer.writeHeader(bytes('[header] '));
    await writer.writeStart(bytes('key1 '));
    await writer.write(bytes('a '));
    await writer.writeStart(bytes('key2 '));
    await writer.write(bytes('b '));
    const late = await registry.open('s', {}, 'r');
    await writer.write(bytes('c'));
    await writer.close();
    assertEquals(await readAll(late), '[header] key2 b c');
  });

  await t.step('past the buffer since a start point, a reader joins at now until the next', async () => {
    const registry = new StreamRegistry({ graceMs: 0, readerBuffer: 8 });
    const writer = await registry.open('s', {}, 'w') as StreamWriter;
    await writer.writeStart(bytes('key '));
    await writer.write(bytes('long run '));
    const now = await registry.open('s', {}, 'r');
    await writer.write(bytes('x'));
    await writer.writeStart(bytes('k2'));
    const next = await registry.open('s', {}, 'r');
    await writer.close();
    assertEquals(await readAll(now), 'xk2');
    assertEquals(await readAll(next), 'k2');
  });

  await t.step('a read takes part of a chunk, and its bytes are its own', async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const writer = await registry.open('s', {}, 'w');
    const first = await registry.open('s', {}, 'r');
    const second = await registry.open('s', {}, 'r');
    const written = bytes('abcdef');
    await writer.write(written);
    written.fill(0);
    const part = await first.read(4);
    assertEquals(text(part), 'abcd');
    part.fill(0);
    assertEquals(text(await first.read(4)), 'ef');
    assertEquals(text(await second.read(16)), 'abcdef');
    await writer.close();
    await first.close();
    await second.close();
  });

  await t.step('a read waits for bytes, and for a writer, and stops when its signal aborts', async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const reader = await registry.open('s', {}, 'r');
    const read = reader.read(16);
    const writer = await registry.open('s', {}, 'w');
    await writer.write(bytes('late'));
    assertEquals(text(await read), 'late');
    const abort = new AbortController();
    const waiting = reader.read(16, abort.signal);
    abort.abort();
    await assertRejects(() => waiting);
    await writer.close();
    assertEquals(await reader.read(16), new Uint8Array(0));
    await reader.close();
  });

  await t.step('one writer at a time; the next starts without the header', async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const writer = await registry.open('s', {}, 'w') as StreamWriter;
    await writer.writeHeader(bytes('h'));
    await assertRejects(() => registry.open('s', {}, 'a'), Error, 'has a writer');
    await assertRejects(() => registry.open('s', {}, 'r+'), Error, 'read or written');
    await writer.close();
    const next = await registry.open('s', {}, 'w');
    const reader = await registry.open('s', {}, 'r');
    await next.write(bytes('fresh'));
    await next.close();
    assertEquals(await readAll(reader), 'fresh');
    await reader.close();
  });

  await t.step('a reader that falls behind reads what it holds and then its end; the writer and others go on', async () => {
    const registry = new StreamRegistry({ graceMs: 0, readerBuffer: 8 });
    const writer = await registry.open('s', {}, 'w');
    const slow = await registry.open('s', {}, 'r');
    const keeping = await registry.open('s', {}, 'r');
    await writer.write(bytes('12345'));
    assertEquals(text(await keeping.read(16)), '12345');
    await writer.write(bytes('6789'));
    assertEquals(text(await keeping.read(16)), '6789');
    assertEquals(await readAll(slow), '12345');
    assertEquals((await registry.stat('s')).readers, 1);
    await writer.close();
    await slow.close();
    await keeping.close();
  });

  await t.step('wanted while someone reads, and for the grace after the last left', async () => {
    const registry = new StreamRegistry({ graceMs: 30 });
    const writer = await registry.open('s', {}, 'w') as StreamWriter;
    const heard: boolean[] = [];
    writer.onWanted((wanted) => heard.push(wanted));
    assertEquals(writer.wanted, false);
    const first = await registry.open('s', {}, 'r');
    const second = await registry.open('s', {}, 'r');
    assertEquals(writer.wanted, true);
    await first.close();
    await second.close();
    assertEquals(writer.wanted, true);
    const again = await registry.open('s', {}, 'r');
    await again.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals([writer.wanted, heard], [false, [true, false]]);
    await writer.close();
    assertEquals(writer.wanted, false);
  });

  await t.step("a stream's node removed closes its writer and ends its readers", async () => {
    const registry = new StreamRegistry({ graceMs: 0 });
    const writer = await registry.open('s', {}, 'w');
    const reader = await registry.open('s', {}, 'r');
    assertEquals(await registry.stat('s'), { size: 0, readers: 1, writer: true });
    assertEquals(await registry.delete('s'), true);
    assert(writer.closed);
    assertEquals(await reader.read(16), new Uint8Array(0));
    await reader.close();
    assertEquals(await registry.count(), 0);
  });

  await t.step('a picture stream gives a reader one picture: the next, written while it waits, and then its end', async () => {
    const registry = new StreamRegistry({ pictureFreshMs: 1_000, pictureWaitMs: 1_000 });
    const writer = await registry.open('p', { mimetype: 'image/jpeg' }, 'w') as StreamWriter;
    const heard: boolean[] = [];
    writer.onWanted((wanted) => heard.push(wanted));
    assertEquals(writer.wanted, false);
    const first = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    const second = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    assertEquals(writer.wanted, true);
    await writer.write(bytes('picture one'));
    assertEquals(writer.wanted, false);
    await writer.write(bytes('picture two'));
    assertEquals(await readAll(first), 'picture one');
    assertEquals(await readAll(second), 'picture one');
    assertEquals(heard, [true, false]);
    await first.close();
    await second.close();
    await writer.close();
  });

  await t.step('a picture stream gives its latest picture while it is fresh, and asks for the next once it is not', async () => {
    const registry = new StreamRegistry({ pictureFreshMs: 30, pictureWaitMs: 1_000 });
    const writer = await registry.open('p', { mimetype: 'image/jpeg' }, 'w') as StreamWriter;
    await writer.writeStart(bytes('fresh'));
    const now = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    assertEquals([await readAll(now), writer.wanted], ['fresh', false]);
    await now.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const later = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    assertEquals(writer.wanted, true);
    await writer.write(bytes('newer'));
    assertEquals(await readAll(later), 'newer');
    await later.close();
    await writer.close();
  });

  await t.step('a picture reader given no new picture in time is given the latest, or its end without one', async () => {
    const registry = new StreamRegistry({ pictureFreshMs: 0, pictureWaitMs: 30 });
    const none = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    assertEquals(await readAll(none), '');
    await none.close();
    const writer = await registry.open('p', { mimetype: 'image/jpeg' }, 'w') as StreamWriter;
    await writer.write(bytes('old'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stale = await registry.open('p', { mimetype: 'image/jpeg' }, 'r');
    assertEquals([await readAll(stale), writer.wanted], ['old', false]);
    await stale.close();
    await writer.close();
  });
});
