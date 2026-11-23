/**
 * What the service worker (`sw.ts`) does with each request, and what it keeps: pure, so it is
 * tested without a browser. Import-free, as the service worker is bundled on its own.
 */

/**
 * How a request is answered:
 *
 * - `document`: a page of the Web UI. The network first, and the kept document when the network
 *   fails, answers with a gateway error (EiN down behind its proxy) or is slow.
 * - `bundle`: a file whose name changes with its content, the shell's or a module's bundle. Kept, and
 *   the kept copy answers.
 * - `shell`: the rest of the Web UI, fonts, icons and the like. The kept copy answers at once and is
 *   refreshed from the network.
 * - `manifest`: the modules' manifest. The network first, the kept copy when it fails.
 * - `file`: a node's bytes a page reads, a picture or a document. The network first, kept when it is
 *   worth keeping (`keepsFile`), the kept copy when the network fails.
 * - `share`: files another app shares to EiN, posted to `SHARE_URL` as the web manifest's
 *   `share_target` says. Kept for the `/share` page, which the answer sends the browser to.
 * - `pass`: left to the browser.
 */
type Plan = 'document' | 'bundle' | 'shell' | 'manifest' | 'file' | 'share' | 'pass';

/** What a plan is judged from: the request as the service worker sees it. */
type PlannedRequest = { method: string; mode: string; url: string; headers: { has(name: string): boolean } };

/** Where the modules' bundles and their manifest are served (`UI_CACHE_PATH` under `/file`). */
const UI_CACHE_URL = '/file/var/cache/ui/';
export const MANIFEST_URL = `${UI_CACHE_URL}manifest.json`;

/** The shell's bundle and stylesheet as `deno bundle` names them: `/index-HFAWGMBR.js`. */
const SHELL_BUNDLE = /^\/[\w.]+-[A-Z0-9]{8}\.(js|css)$/;
/** A module's bundle or stylesheet as `ui-build` names it: `/file/var/cache/ui/<module>/<sha256 head>.js`. */
const MODULE_BUNDLE = /^\/file\/var\/cache\/ui\/[^/]+\/[0-9a-f]{12}\.(js|css)$/;
/** A file of the Web UI at the top (favicons, the web manifest, its icons), or under `/public/` and `/icons/`. */
const SHELL_FILE = /^\/([^/]+\.\w+|public\/.+|icons\/.+)$/;
/** Where the web manifest's `share_target` posts shared files, and the page that takes them. */
export const SHARE_URL = '/share';
/** The form field the shared files are posted in, as the web manifest's `share_target` names it. */
export const SHARE_FILES_FIELD = 'files';
/** Where the service worker itself is served; the browser fetches it past the worker. */
const WORKER_URL = '/sw.js';

/** Whose bundle a path is, the shell's or a module's; null when it is none. */
export function bundleOf(path: string): 'shell' | 'module' | null {
  return SHELL_BUNDLE.test(path) ? 'shell' : MODULE_BUNDLE.test(path) ? 'module' : null;
}

/** Paths that are never a page of the Web UI, though a browser may navigate to them. */
const NOT_PAGES = ['/file/', '/dav/', '/upload/', '/__'];

/** How a request is answered (`Plan`), for a page at `origin`. */
export function planFor(request: PlannedRequest, origin: string): Plan {
  const url = new URL(request.url);
  if (url.origin !== origin) return 'pass';
  const path = url.pathname;
  if (request.method === 'POST' && request.mode === 'navigate' && path === SHARE_URL) return 'share';
  if (request.method !== 'GET' || request.headers.has('range')) return 'pass';
  if (request.mode === 'navigate') return NOT_PAGES.some((prefix) => path.startsWith(prefix)) ? 'pass' : 'document';
  if (path.startsWith('/__') || path === WORKER_URL) return 'pass';
  if (path === MANIFEST_URL) return 'manifest';
  if (bundleOf(path)) return 'bundle';
  if (path.startsWith('/file/')) return 'file';
  if (SHELL_FILE.test(path)) return 'shell';
  return 'pass';
}

/** The largest file kept. */
const FILE_MAX_BYTES = 4 * 1024 * 1024;

/** The types kept: pictures, and the text, JSON and PDF a page reads. */
const KEPT_TYPES = /^(image\/|text\/|application\/json\b|application\/pdf\b)/;

/**
 * Whether a `file` answer is kept: a picture or a document of up to `FILE_MAX_BYTES`, not a video,
 * a sound or a download.
 */
export function keepsFile(status: number, contentType: string | null, disposition: string | null, size: number): boolean {
  return status === 200 && size <= FILE_MAX_BYTES && KEPT_TYPES.test(contentType ?? '') && !/^\s*attachment/i.test(disposition ?? '');
}

/** How many bytes of files are kept. */
const FILES_BUDGET = 150 * 1024 * 1024;

/** How many of the kept files go, oldest first, so the newest fit in `budget`: given each one's size, oldest first. */
export function overBudget(sizes: readonly number[], budget = FILES_BUDGET): number {
  let total = 0;
  for (let i = sizes.length - 1; i >= 0; i--) {
    total += sizes[i];
    if (total > budget) return i + 1;
  }
  return 0;
}

/** The files a document of the Web UI loads itself, as paths: its scripts, stylesheets, icons and web manifest. */
export function documentAssets(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=(["'])([^"']+)\1/gi)) {
    const ref = match[2];
    const path = ref.startsWith('./') ? ref.slice(1) : ref;
    if (path.startsWith('/') && !path.startsWith('//')) found.add(path);
  }
  return [...found];
}

/** The fonts and pictures a stylesheet loads from the Web UI's `/public/`. */
export function stylesheetAssets(css: string): string[] {
  return [...new Set([...css.matchAll(/url\(\s*(["']?)(\/public\/[^"')]+)\1\s*\)/g)].map((match) => match[2]))];
}

/** A module manifest's bundles and stylesheets. */
export function manifestAssets(manifest: unknown): string[] {
  const modules = (manifest as { modules?: Record<string, { url?: unknown; css?: unknown }> } | null)?.modules ?? {};
  return Object.values(modules).flatMap((entry) => [entry.url, entry.css]).filter((url): url is string => typeof url === 'string');
}
