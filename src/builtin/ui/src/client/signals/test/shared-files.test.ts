import { assertEquals } from '@std/assert';
import { loadSharedFiles, takeSharedFiles } from '../shared-files.ts';

/** A stand-in for the app's `window.EinApp`, which keeps `files` and hands them on in `piece`-byte pieces. */
function standInApp(files: { name: string; type: string; modified?: number; bytes: Uint8Array }[], piece: number) {
  const calls: string[] = [];
  let kept = files;
  const listeners: ((event: MessageEvent) => void)[] = [];
  const answer = (id: number, result: unknown) =>
    queueMicrotask(() => listeners.forEach((listener) => listener(new MessageEvent('message', { data: JSON.stringify({ id, result }) }))));
  const app = {
    addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => listeners.push(listener),
    postMessage(message: string) {
      const { id, method, params } = JSON.parse(message);
      calls.push(method);
      if (method === 'shared') answer(id, { files: kept.map(({ name, type, modified, bytes }) => ({ name, type, modified, size: bytes.length })) });
      if (method === 'sharedRead') {
        const bytes = kept[params.index].bytes.subarray(params.offset, params.offset + piece);
        answer(id, { data: btoa(String.fromCharCode(...bytes)), end: bytes.length < piece });
      }
      if (method === 'sharedDone') {
        kept = [];
        answer(id, {});
      }
    },
  };
  return { app, calls };
}

Deno.test('shared files: in the app, each file is read from it piece by piece, then the app forgets them', async () => {
  const photo = Uint8Array.from({ length: 10 }, (_, i) => i);
  const { app, calls } = standInApp([
    { name: 'IMG_1.jpg', type: 'image/jpeg', modified: 1_700_000_000_000, bytes: photo },
    { name: 'note.m4a', type: 'audio/mp4', bytes: new Uint8Array(4) },
  ], 4);
  (globalThis as { EinApp?: unknown }).EinApp = app;
  try {
    assertEquals(await loadSharedFiles(), 2);
    const [first, second] = takeSharedFiles();
    assertEquals([first.name, first.type, first.lastModified], ['IMG_1.jpg', 'image/jpeg', 1_700_000_000_000]);
    assertEquals(new Uint8Array(await first.arrayBuffer()), photo);
    assertEquals([second.name, second.size], ['note.m4a', 4]);
    assertEquals(calls, ['shared', 'sharedRead', 'sharedRead', 'sharedRead', 'sharedRead', 'sharedRead', 'sharedDone']);
    assertEquals(takeSharedFiles(), []);
    assertEquals(await loadSharedFiles(), 0);
  } finally {
    delete (globalThis as { EinApp?: unknown }).EinApp;
  }
});
