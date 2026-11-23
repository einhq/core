/**
 * The Web UI's service worker, served at `/sw.js` (ein/core#1522): it keeps the Web UI so a page of
 * it opens without a connection, and the pictures and documents opened recently so they can be seen
 * there. What a page reads through the shell's socket it keeps itself (`lib/saved-answers.ts`); a
 * service worker sees no socket.
 *
 * Bundled on its own by `bundle.ts`, as a classic script: it imports only import-free files.
 */

import { FILES_CACHE, OWN_CACHES, SHARED_CACHE, SHARED_NAME_HEADER, SHELL_CACHE } from './caches.ts';
import { bundleOf, documentAssets, keepsFile, MANIFEST_URL, manifestAssets, overBudget, planFor, SHARE_FILES_FIELD, SHARE_URL, stylesheetAssets } from './rules.ts';

type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { request: Request; respondWith(response: Promise<Response>): void };
/** What of a service worker's global scope this one uses: the DOM library the UI is checked with has no such type. */
type WorkerScope = {
  location: Location;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const worker = globalThis as unknown as WorkerScope;
const origin = worker.location.origin;

/** The kept document, under one key for every page: each is the same document. */
const DOCUMENT_KEY = `${origin}/`;
/** How long a page waits for the network before the kept document stands in. */
const DOCUMENT_WAIT_MS = 4000;
/** A proxy's answers while EiN behind it is down or starting: EiN is out of reach as much as without a network. */
const GATEWAY_ERRORS = new Set([502, 503, 504]);
/** The header a kept file carries its size in, for pruning. */
const SIZE_HEADER = 'x-ein-size';
/** How many files are kept between looks at the budget. */
const PRUNE_EVERY = 25;

const absolute = (path: string): string => new URL(path, origin).href;

/** The network's answer, or null when there is none. */
const reach = (request: Request | string, init?: RequestInit): Promise<Response | null> => fetch(request, init).catch(() => null);

/** Whether an answer came from EiN: not none, and not its proxy saying EiN is down. */
const fromEin = (response: Response | null): response is Response => response !== null && !GATEWAY_ERRORS.has(response.status);

/** Keep those of `paths` not kept yet, quietly: one that does not answer is kept when a page asks for it. */
const keepMissing = async (cache: Cache, paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map(async (path) => {
    if (await cache.match(absolute(path))) return;
    const response = await reach(path);
    if (response?.ok) await cache.put(absolute(path), response);
  }));
};

/** Drop the kept bundles of `kind` that `named` no longer names. */
const dropBundles = async (cache: Cache, kind: 'shell' | 'module', named: readonly string[]): Promise<void> => {
  const keep = new Set(named.map(absolute));
  for (const request of await cache.keys()) {
    if (bundleOf(new URL(request.url).pathname) === kind && !keep.has(request.url)) await cache.delete(request);
  }
};

/** Keep the document and what it and its stylesheets load, dropping the shell bundles it no longer names. */
const keepDocument = async (cache: Cache, response: Response): Promise<void> => {
  const assets = documentAssets(await response.clone().text());
  await cache.put(DOCUMENT_KEY, response);
  await keepMissing(cache, assets);
  const styles = await Promise.all(assets.filter((path) => path.endsWith('.css')).map(async (path) => (await cache.match(absolute(path)))?.text() ?? ''));
  await keepMissing(cache, styles.flatMap(stylesheetAssets));
  await dropBundles(cache, 'shell', assets);
};

/** Keep the manifest and the bundles it names, dropping the module bundles it no longer names. */
const keepManifest = async (cache: Cache, response: Response): Promise<void> => {
  const bundles = manifestAssets(await response.clone().json());
  await cache.put(absolute(MANIFEST_URL), response);
  await keepMissing(cache, bundles);
  await dropBundles(cache, 'module', bundles);
};

/** Keep the Web UI as the server has it now: the document with what it loads, and the modules' bundles. */
const keepWebUi = async (): Promise<void> => {
  const cache = await caches.open(SHELL_CACHE);
  const document = await reach('/', { cache: 'no-cache' });
  if (document?.ok) await keepDocument(cache, document).catch(() => {});
  const manifest = await reach(MANIFEST_URL, { cache: 'no-cache' });
  if (manifest?.ok) await keepManifest(cache, manifest).catch(() => {});
};

const isHtml = (response: Response): boolean => response.headers.get('content-type')?.startsWith('text/html') === true;

/** A page: the network first; the kept document when there is no answer from EiN, or while the network keeps the page waiting. */
const answerDocument = async (event: FetchEvent): Promise<Response> => {
  const cache = await caches.open(SHELL_CACHE);
  const network = reach(event.request);
  event.waitUntil(
    network.then(async (response) => {
      if (response?.ok && isHtml(response)) await keepDocument(cache, response.clone());
    }).catch(() => {}),
  );
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const slow = new Promise<'slow'>((resolve) => timer = globalThis.setTimeout(() => resolve('slow'), DOCUMENT_WAIT_MS));
  const first = await Promise.race([network, slow]);
  globalThis.clearTimeout(timer);
  if (first !== 'slow' && fromEin(first)) return first;
  const kept = await cache.match(DOCUMENT_KEY);
  if (kept) return kept;
  return (await network) ?? Response.error();
};

/** A bundle: the kept copy, or the network's, kept. */
const answerBundle = async (request: Request): Promise<Response> => {
  const cache = await caches.open(SHELL_CACHE);
  const kept = await cache.match(request.url);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) await cache.put(request.url, response.clone());
  return response;
};

/** The rest of the Web UI: the kept copy at once, refreshed from the network for the next time. */
const answerShell = async (event: FetchEvent): Promise<Response> => {
  const cache = await caches.open(SHELL_CACHE);
  const refresh = reach(event.request).then(async (response) => {
    if (response?.ok) await cache.put(event.request.url, response.clone());
    return response;
  });
  const kept = await cache.match(event.request.url);
  if (kept) {
    event.waitUntil(refresh);
    return kept;
  }
  return (await refresh) ?? Response.error();
};

/** The manifest: the network first, kept with the bundles it names; the kept copy when there is no answer from EiN. */
const answerManifest = async (event: FetchEvent): Promise<Response> => {
  const cache = await caches.open(SHELL_CACHE);
  const response = await reach(event.request);
  if (fromEin(response)) {
    if (response.ok) event.waitUntil(keepManifest(cache, response.clone()).catch(() => {}));
    return response;
  }
  return (await cache.match(event.request.url)) ?? response ?? Response.error();
};

let keptSincePrune = 0;

/** Drop the files kept longest ago past the budget. The cache lists them in the order they were kept. */
const pruneFiles = async (cache: Cache): Promise<void> => {
  const requests = await cache.keys();
  const sizes = await Promise.all(requests.map(async (request) => Number((await cache.match(request))?.headers.get(SIZE_HEADER) ?? 0)));
  await Promise.all(requests.slice(0, overBudget(sizes)).map((request) => cache.delete(request)));
};

/** Keep a file a page read, with its size, when it is worth keeping. */
const keepFile = async (url: string, response: Response): Promise<void> => {
  const body = await response.blob();
  if (!keepsFile(response.status, response.headers.get('content-type'), response.headers.get('content-disposition'), body.size)) return;
  const headers = new Headers(response.headers);
  headers.set(SIZE_HEADER, String(body.size));
  const cache = await caches.open(FILES_CACHE);
  await cache.put(url, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  if (++keptSincePrune >= PRUNE_EVERY) {
    keptSincePrune = 0;
    await pruneFiles(cache);
  }
};

/** A node's bytes: the network first, kept; the kept copy when there is no answer from EiN. */
const answerFile = async (event: FetchEvent): Promise<Response> => {
  const response = await reach(event.request);
  if (fromEin(response)) {
    if (response.status === 200) event.waitUntil(keepFile(event.request.url, response.clone()).catch(() => {}));
    return response;
  }
  return (await (await caches.open(FILES_CACHE)).match(event.request.url, { ignoreVary: true })) ?? response ?? Response.error();
};

/**
 * Files another app shared: kept in `SHARED_CACHE` in the order they came, in place of any shared
 * before and not taken, and the browser sent on to the `/share` page, which takes them.
 */
const answerShare = async (request: Request): Promise<Response> => {
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll(SHARE_FILES_FIELD) ?? []).filter((entry): entry is File => typeof entry !== 'string');
  await caches.delete(SHARED_CACHE);
  const cache = await caches.open(SHARED_CACHE);
  for (const [index, file] of files.entries()) {
    const headers = { 'content-type': file.type || 'application/octet-stream', [SHARED_NAME_HEADER]: encodeURIComponent(file.name) };
    await cache.put(absolute(`${SHARE_URL}/${index}`), new Response(file, { headers }));
  }
  return Response.redirect(absolute(SHARE_URL), 303);
};

worker.addEventListener('install', (event) => {
  void worker.skipWaiting();
  event.waitUntil(keepWebUi());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((name) => !OWN_CACHES.includes(name)).map((name) => caches.delete(name)));
    await worker.clients.claim();
  })());
});

worker.addEventListener('fetch', (event) => {
  switch (planFor(event.request, origin)) {
    case 'document':
      return event.respondWith(answerDocument(event));
    case 'bundle':
      return event.respondWith(answerBundle(event.request));
    case 'shell':
      return event.respondWith(answerShell(event));
    case 'manifest':
      return event.respondWith(answerManifest(event));
    case 'file':
      return event.respondWith(answerFile(event));
    case 'share':
      return event.respondWith(answerShare(event.request));
  }
});
