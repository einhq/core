/**
 * Files another app shared to EiN through the phone's Share menu: in a browser the web manifest's
 * `share_target`, whose files the service worker keeps (`sw/sw.ts`); in the EiN app for Android
 * its own share, whose files the app keeps and hands on through `window.EinApp`. The `/share` page
 * reads them here, and the module route that takes them (a `share.receive` panel) takes them with
 * `takeSharedFiles`.
 */

import { appShared, appSharedDone, appSharedRead, inEinApp } from '../lib/ein-app.ts';
import { SHARED_CACHE, SHARED_NAME_HEADER } from '../sw/caches.ts';

let shared: File[] = [];

/** Read the files shared to EiN into the page, emptying where they were kept; answers how many. */
export async function loadSharedFiles(): Promise<number> {
  const files = inEinApp() ? await fromApp() : await fromWorker();
  shared = files;
  return files.length;
}

/** The files the service worker kept, emptying its cache. */
async function fromWorker(): Promise<File[]> {
  const store = globalThis.caches;
  if (!store) return [];
  const cache = await store.open(SHARED_CACHE);
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const name = decodeURIComponent(response.headers.get(SHARED_NAME_HEADER) ?? '') || 'shared';
    files.push(new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' }));
  }
  await store.delete(SHARED_CACHE);
  return files;
}

/** The files the app kept, read piece by piece, then forgotten by the app. */
async function fromApp(): Promise<File[]> {
  const { files: listed } = await appShared();
  const files: File[] = [];
  for (const [index, file] of listed.entries()) {
    const parts: Blob[] = [];
    for (let offset = 0;;) {
      const { data, end } = await appSharedRead(index, offset);
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      parts.push(new Blob([bytes]));
      offset += bytes.length;
      if (end) break;
    }
    files.push(new File(parts, file.name, { type: file.type, lastModified: file.modified }));
  }
  await appSharedDone();
  return files;
}

/** The files shared to EiN that nothing has taken yet, taken: a second call answers none. */
export function takeSharedFiles(): File[] {
  const files = shared;
  shared = [];
  return files;
}
