import { assertEquals, assertRejects } from '@std/assert';
import { PIECE_BYTES, sendInPieces, type TusAnswer, type TusIo, tusMetadata } from '../tus-upload.ts';

const answer = (status: number, headers: Record<string, string> = {}, text = ''): TusAnswer => ({
  status,
  header: (name) => headers[name.toLowerCase()] ?? null,
  text,
});

type Fault = (method: string, piece: number) => 'drop-half' | 'lose-answer' | TusAnswer | undefined;

/** A tus server in memory, whose answers `fault` may spoil, recording each request. */
const fakeServer = (length: number, fault: Fault = () => undefined) => {
  let offset = 0;
  let stored: string | undefined;
  let patches = 0;
  const calls: string[] = [];
  const done = (headers: Record<string, string>) => stored ? { ...headers, 'content-location': '/file/tmp/clip%20(2).mp4' } : headers;
  const io: TusIo = {
    request: (method, _url, headers, body, progress) => {
      calls.push(method === 'PATCH' ? `PATCH ${headers['Upload-Offset']}` : method);
      if (method === 'POST') return Promise.resolve(answer(201, done({ location: '/upload/01ABC' })));
      if (method === 'HEAD') return Promise.resolve(answer(200, done({ 'upload-offset': String(offset) })));
      if (method === 'DELETE') return Promise.resolve(answer(204));
      const spoiled = fault(method, patches++);
      if (spoiled && typeof spoiled === 'object') return Promise.resolve(spoiled);
      const size = body!.size;
      const arrived = spoiled === 'drop-half' ? Math.floor(size / 2) : size;
      progress?.(arrived);
      offset += arrived;
      if (offset === length) stored = '/tmp/clip (2).mp4';
      if (spoiled) return Promise.resolve(answer(0));
      return Promise.resolve(answer(204, done({ 'upload-offset': String(offset) })));
    },
    sleep: () => Promise.resolve(),
  };
  return { io, calls, offset: () => offset };
};

const file = (size: number) => Object.assign(new Blob([new Uint8Array(size)]), { name: 'clip.mp4', lastModified: 1_700_000_000_500 });

Deno.test('a file goes in pieces, and the stored path is the one the server names', async () => {
  const size = PIECE_BYTES * 2 + 10;
  const server = fakeServer(size);
  const seen: number[] = [];
  const path = await sendInPieces(server.io, file(size), '/tmp', (sent) => seen.push(sent), new AbortController().signal);
  assertEquals(path, '/tmp/clip (2).mp4');
  assertEquals(server.calls, ['POST', 'PATCH 0', `PATCH ${PIECE_BYTES}`, `PATCH ${PIECE_BYTES * 2}`]);
  assertEquals(seen.at(-1), size);
});

Deno.test('a piece that breaks off is not sent again from the start: the server is asked how far it got', async () => {
  const size = PIECE_BYTES + 100;
  const server = fakeServer(size, (_, piece) => piece === 0 ? 'drop-half' : undefined);
  await sendInPieces(server.io, file(size), '/tmp', () => {}, new AbortController().signal);
  assertEquals(server.calls, ['POST', 'PATCH 0', 'HEAD', `PATCH ${PIECE_BYTES / 2}`]);
  assertEquals(server.offset(), size);
});

Deno.test('a last answer that was lost is made up by asking', async () => {
  const server = fakeServer(10, () => 'lose-answer');
  assertEquals(await sendInPieces(server.io, file(10), '/tmp', () => {}, new AbortController().signal), '/tmp/clip (2).mp4');
  assertEquals(server.calls, ['POST', 'PATCH 0', 'HEAD']);
});

Deno.test("a refusal that asking again cannot change fails the file with the server's reason", async () => {
  const server = fakeServer(10, () => answer(403, {}, 'the folder may not be written\n'));
  await assertRejects(() => sendInPieces(server.io, file(10), '/tmp', () => {}, new AbortController().signal), Error, 'the folder may not be written');
});

Deno.test('a connection that never comes back fails the file after its retries', async () => {
  const server = fakeServer(10, () => answer(0));
  server.io.request = ((request) => (method, ...rest) => method === 'HEAD' ? Promise.resolve(answer(0)) : request(method, ...rest))(server.io.request);
  await assertRejects(() => sendInPieces(server.io, file(10), '/tmp', () => {}, new AbortController().signal), Error, 'network error');
});

Deno.test('the metadata is base64 of UTF-8', () => {
  assertEquals(tusMetadata({ filename: 'Åsa.jpg', dir: '/tmp' }), `filename ${btoa('Ã\u0085sa.jpg')},dir ${btoa('/tmp')}`);
});
