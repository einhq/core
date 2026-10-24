import { assertEquals, assertRejects } from '@std/assert';
import { deferred } from '../../../lib/async/deferred.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';
import { fileBody } from '../handlers/file-body.ts';
import { handleGetFile } from '../handlers/get-file.ts';
import type { HttpServerConfig } from '../types.ts';

const bytes = new TextEncoder().encode('0123456789');

function fixture() {
  let position = 0;
  let closes = 0;
  let reads = 0;
  let opens = 0;
  const handle = {
    get readable() {
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await handle.read(64 * 1024);
          if (chunk.length) controller.enqueue(chunk);
          else controller.close();
        },
      });
    },
    read(size: number) {
      reads++;
      const chunk = bytes.slice(position, position + size);
      position += chunk.length;
      return Promise.resolve(chunk);
    },
    seek(offset: number) {
      position = offset;
      return Promise.resolve(offset);
    },
    close() {
      closes++;
      return Promise.resolve();
    },
  } as unknown as ResourceHandleIf;
  // The requests are the site's own (`site`): what these pin down is the body's handle, not who
  // may read it, and the stand-in VFS holds no settings to ask.
  const config = {
    env: { COOKIE_NAME: 'session' },
    vfs: {
      resolvePath: (_access: unknown, path: string) => Promise.resolve({ id: path, absPath: path, vfsAbsPath: path }),
      get: () => Promise.resolve({ type: 'file', attrs: { size: bytes.length, mimetype: 'text/plain', sha256: 'hash' } }),
      open: () => {
        opens++;
        return Promise.resolve(handle);
      },
    },
  } as unknown as HttpServerConfig;
  return { handle, config, stats: () => ({ closes, reads, opens }) };
}

Deno.test('HTTP full and range downloads close their resource handles', async () => {
  for (const range of [undefined, 'bytes=3-5']) {
    const f = fixture();
    const req = new Request('http://localhost/file/test', { headers: range ? { range } : {} });
    const res = await handleGetFile(f.config, req, new URL(req.url), { site: true });
    assertEquals(await res.text(), range ? '345' : '0123456789');
    assertEquals(f.stats(), { closes: 1, reads: 1, opens: 1 });
  }
});

Deno.test('HTTP bodyless responses do not open a resource', async () => {
  const cases: RequestInit[] = [{ method: 'HEAD' }, { headers: { range: 'bytes=99-' } }, { headers: { 'if-none-match': '"hash"' } }];
  for (const options of cases) {
    const f = fixture();
    const req = new Request('http://localhost/file/test', options);
    const res = await handleGetFile(f.config, req, new URL(req.url), { site: true });
    await res.body?.cancel();
    assertEquals(f.stats(), { closes: 0, reads: 0, opens: 0 });
  }
});

Deno.test('HTTP range seek failure closes the handle', async () => {
  const f = fixture();
  f.handle.seek = () => Promise.reject(new Error('seek failed'));
  const req = new Request('http://localhost/file/test', { headers: { range: 'bytes=3-5' } });
  await assertRejects(() => handleGetFile(f.config, req, new URL(req.url), { site: true }), Error, 'seek failed');
  assertEquals(f.stats().closes, 1);
});

Deno.test('HTTP body cancellation and request abort close without eager reads', async () => {
  for (const abort of [false, true]) {
    const f = fixture();
    const ac = new AbortController();
    const stream = fileBody(f.handle, bytes.length, ac.signal);
    assertEquals(f.stats().reads, 0);
    if (abort) {
      ac.abort();
      await assertRejects(() => stream.getReader().read(), DOMException);
      // The stream errors immediately; the handle cleanup finishes asynchronously.
      await Promise.resolve();
    } else {
      await stream.cancel();
    }
    assertEquals(f.stats().closes, 1);
  }
});

Deno.test('HTTP cancellation waits for an in-flight lazy handle read before closing', async () => {
  const f = fixture();
  const started = deferred<void>();
  const read = deferred<Uint8Array>();
  f.handle.read = () => {
    started.resolve();
    return read;
  };
  const reader = fileBody(f.handle, bytes.length, new AbortController().signal).getReader();
  const reading = reader.read();
  await started;
  const cancellation = reader.cancel();
  assertEquals(f.stats().closes, 0);
  read.resolve(bytes);
  await cancellation;
  await reading;
  assertEquals(f.stats().closes, 1);
});

Deno.test('HTTP read failures and early EOF close the handle', async () => {
  for (const failure of [false, true]) {
    const f = fixture();
    f.handle.read = () => failure ? Promise.reject(new Error('read failed')) : Promise.resolve(new Uint8Array());
    const response = new Response(fileBody(f.handle, bytes.length, new AbortController().signal));
    if (failure) await assertRejects(() => response.text(), Error, 'read failed');
    else assertEquals(await response.text(), '');
    assertEquals(f.stats().closes, 1);
  }
});
