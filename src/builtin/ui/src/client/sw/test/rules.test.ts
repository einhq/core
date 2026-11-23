import { assertEquals } from '@std/assert';
import { bundleOf, documentAssets, keepsFile, manifestAssets, overBudget, planFor, SHARE_FILES_FIELD, SHARE_URL, stylesheetAssets } from '../rules.ts';

const ORIGIN = 'https://ein.example';

const plan = (path: string, init: { method?: string; mode?: string; range?: boolean; origin?: string } = {}) =>
  planFor({
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    url: `${init.origin ?? ORIGIN}${path}`,
    headers: new Headers(init.range ? { range: 'bytes=0-' } : {}),
  }, ORIGIN);

Deno.test('a page of the Web UI is the document, wherever it is', () => {
  assertEquals(plan('/', { mode: 'navigate' }), 'document');
  assertEquals(plan('/people/Anna%20Andersson', { mode: 'navigate' }), 'document');
  assertEquals(plan('/s/abc123', { mode: 'navigate' }), 'document');
});

Deno.test("a node, a WebDAV path, an upload or the server's own paths are no page", () => {
  assertEquals(plan('/file/home/anna/notes.md', { mode: 'navigate' }), 'pass');
  assertEquals(plan('/dav/home/anna/', { mode: 'navigate' }), 'pass');
  assertEquals(plan('/upload/x', { mode: 'navigate' }), 'pass');
  assertEquals(plan('/__session', { mode: 'navigate' }), 'pass');
  assertEquals(plan('/__session'), 'pass');
});

Deno.test("bundles whose names follow their content are bundles, the shell's and the modules'", () => {
  assertEquals(plan('/index-IN5RKZ7O.js'), 'bundle');
  assertEquals(plan('/index-5PQ5SOLS.css'), 'bundle');
  assertEquals(plan('/file/var/cache/ui/archive/0123456789ab.js'), 'bundle');
  assertEquals(plan('/file/var/cache/ui/archive/0123456789ab.css'), 'bundle');
  assertEquals(bundleOf('/index-IN5RKZ7O.js'), 'shell');
  assertEquals(bundleOf('/file/var/cache/ui/archive/0123456789ab.js'), 'module');
  assertEquals(bundleOf('/file/var/cache/ui/manifest.json'), null);
  assertEquals(bundleOf('/favicon.ico'), null);
});

Deno.test('the manifest, the rest of the Web UI and the nodes a page reads', () => {
  assertEquals(plan('/file/var/cache/ui/manifest.json'), 'manifest');
  assertEquals(plan('/favicon.svg'), 'shell');
  assertEquals(plan('/manifest.webmanifest'), 'shell');
  assertEquals(plan('/public/fonts/inter-latin.woff2'), 'shell');
  assertEquals(plan('/icons/tabler/outline/camera.svg'), 'shell');
  assertEquals(plan('/file/home/anna/Pictures/a.jpg/thumbnails/grid.webp'), 'file');
  assertEquals(plan('/file/var/cache/ui/licences.txt'), 'file');
});

Deno.test('the worker itself, a write, a byte range and another origin are left to the browser', () => {
  assertEquals(plan('/sw.js'), 'pass');
  assertEquals(plan('/file/home/anna/a.txt', { method: 'PUT' }), 'pass');
  assertEquals(plan('/file/home/anna/film.mp4', { range: true }), 'pass');
  assertEquals(plan('/index-IN5RKZ7O.js', { origin: 'https://elsewhere.example' }), 'pass');
  assertEquals(plan('/some/route'), 'pass');
});

Deno.test('files shared to EiN are posted to the share page, which is a page when it is opened', () => {
  assertEquals(plan('/share', { method: 'POST', mode: 'navigate' }), 'share');
  assertEquals(plan('/share', { mode: 'navigate' }), 'document');
  assertEquals(plan('/share', { method: 'POST' }), 'pass');
  assertEquals(plan('/share/0', { method: 'POST', mode: 'navigate' }), 'pass');
  assertEquals(plan('/share', { method: 'POST', mode: 'navigate', origin: 'https://elsewhere.example' }), 'pass');
});

Deno.test("the web manifest's share target posts its files where the worker takes them", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('../../root/manifest.webmanifest', import.meta.url)));
  const target = manifest.share_target;
  assertEquals([target.action, target.method, target.enctype], [SHARE_URL, 'POST', 'multipart/form-data']);
  assertEquals(target.params.files.map((field: { name: string }) => field.name), [SHARE_FILES_FIELD]);
});

Deno.test("a picture or a document of a page's size is kept; a video, a sound, a download or a large file is not", () => {
  assertEquals(keepsFile(200, 'image/webp', null, 40_000), true);
  assertEquals(keepsFile(200, 'text/markdown; charset=utf-8', null, 2_000), true);
  assertEquals(keepsFile(200, 'application/json', null, 2_000), true);
  assertEquals(keepsFile(200, 'application/pdf', null, 900_000), true);
  assertEquals(keepsFile(200, 'video/mp4', null, 90_000), false);
  assertEquals(keepsFile(200, 'audio/mpeg', null, 90_000), false);
  assertEquals(keepsFile(200, 'image/jpeg', 'attachment; filename="a.jpg"', 90_000), false);
  assertEquals(keepsFile(200, 'image/jpeg', null, 5 * 1024 * 1024), false);
  assertEquals(keepsFile(206, 'image/jpeg', null, 1_000), false);
  assertEquals(keepsFile(200, null, null, 1_000), false);
});

Deno.test('past the budget the oldest go, as many as the newest need', () => {
  assertEquals(overBudget([], 10), 0);
  assertEquals(overBudget([3, 3, 3], 10), 0);
  assertEquals(overBudget([3, 3, 3, 3], 10), 1);
  assertEquals(overBudget([8, 1, 1, 9], 10), 2);
  assertEquals(overBudget([1, 1, 11], 10), 3);
});

Deno.test("a document's own files are read from its tags, relative or not, and nothing elsewhere", () => {
  const html = `<!DOCTYPE html><html><head>
    <base href="/" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta property="og:image" content="%EIN_ORIGIN%/og-image.jpg" />
    <script src="./index-IN5RKZ7O.js" type="module" crossorigin></script>
    <link rel="stylesheet" crossorigin href="./index-5PQ5SOLS.css">
    <link rel="preconnect" href="//cdn.example" />
  </head></html>`;
  assertEquals(documentAssets(html), ['/favicon.ico', '/manifest.webmanifest', '/index-IN5RKZ7O.js', '/index-5PQ5SOLS.css']);
});

Deno.test("a stylesheet's fonts under /public are read, quoted or not, once each", () => {
  const css = `@font-face{src:url(/public/fonts/inter-latin.woff2)}a{background:url("data:image/svg+xml,x")}
    @font-face{src:url('/public/fonts/mochiy-latin.woff2')}b{src:url(/public/fonts/inter-latin.woff2)}`;
  assertEquals(stylesheetAssets(css), ['/public/fonts/inter-latin.woff2', '/public/fonts/mochiy-latin.woff2']);
});

Deno.test("a manifest's bundles and stylesheets", () => {
  const manifest = {
    runtime: 'x',
    modules: {
      archive: { url: '/file/var/cache/ui/archive/0123456789ab.js', css: '/file/var/cache/ui/archive/ba9876543210.css', routes: [] },
      devices: { url: '/file/var/cache/ui/devices/aaaaaaaaaaaa.js', routes: [] },
    },
  };
  assertEquals(manifestAssets(manifest), [
    '/file/var/cache/ui/archive/0123456789ab.js',
    '/file/var/cache/ui/archive/ba9876543210.css',
    '/file/var/cache/ui/devices/aaaaaaaaaaaa.js',
  ]);
  assertEquals(manifestAssets(null), []);
});
