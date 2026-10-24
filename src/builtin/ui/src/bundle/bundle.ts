/**
 * Build the shell into `src/builtin/ui/ui/`: `deno bundle` over `src/client/index.html`, which loads
 * `main.tsx`, plus the files served beside it. `--dev` keeps the bundler watching the sources.
 *
 * - `root/` (favicons, the web manifest and its icons) is copied to the top, where browsers ask
 *   for them, and `public/` (fonts, patterns) under `public/`;
 * - `nav.json`, the shell's own navigation entries (linked into /etc/ui/nav.d at boot, beside
 *   the modules'), parsed so a syntax error fails here instead of on every page load;
 * - every Tabler icon as an SVG file under `icons/tabler/{outline,filled}/<name>.svg`, so
 *   configuration and module bundles can name any icon without the shell bundling ~5000 React
 *   components (`TablerIcon` reads them). They come from the node_modules directory the bundler
 *   materialises, so they are copied after it, keeping their timestamps so a deploy's rsync skips
 *   the unchanged ones.
 *
 * In `--dev` only the bundle is rebuilt on a change; the rest is copied once.
 */
import { format } from '@std/fmt/bytes';
import { copy, emptyDir, exists } from '@std/fs';
import { dirname, fromFileUrl, join } from '@std/path';

const dev = Deno.args.includes('--dev');
const uiDir = join(dirname(fromFileUrl(import.meta.url)), '..', '..');
const srcDir = join(uiDir, 'src', 'client');
const distDir = join(uiDir, 'ui');
const repoDir = join(uiDir, '..', '..', '..');
const denoConfig = join(repoDir, 'deno.jsonc');

await emptyDir(distDir);
await copy(join(srcDir, 'root'), distDir, { overwrite: true });
await copy(join(srcDir, 'public'), join(distDir, 'public'));
const nav = JSON.parse(await Deno.readTextFile(join(srcDir, 'nav.json')));
await Deno.writeTextFile(join(distDir, 'nav.json'), `${JSON.stringify(nav, null, 2)}\n`);

const args = [
  'bundle',
  '--config',
  denoConfig,
  // Required, not optional: reading npm packages straight out of the global cache, the bundler
  // fails to resolve subpaths of packages that have no `exports` map and rely on a legacy
  // `<subpath>/package.json` redirect — react-remove-scroll-bar/constants (pulled in by Mantine
  // via react-remove-scroll) dies with ERR_MODULE_NOT_FOUND for a file that is present on disk.
  // A real node_modules makes node resolution work normally.
  '--node-modules-dir=auto',
  // Self-hosted fonts are referenced from CSS as /public/fonts/*.woff2 and copied above, not
  // bundled. Without this the bundler tries to resolve those url()s from disk and fails.
  '--external',
  '/public/*',
  '--platform',
  'browser',
  '--outdir',
  distDir,
  ...(dev ? ['--watch', '--sourcemap=linked'] : ['--minify']),
  join(srcDir, 'index.html'),
];
console.log(`${Deno.execPath()} ${args.join(' ')}`);
const bundler = new Deno.Command(Deno.execPath(), { args, stdout: 'inherit', stderr: 'inherit' });

const icons = join(repoDir, 'node_modules', '@tabler', 'icons', 'icons');
const copyIcons = async () => {
  for (const style of ['outline', 'filled']) {
    await copy(join(icons, style), join(distDir, 'icons', 'tabler', style), { overwrite: true, preserveTimestamps: true });
  }
};

if (dev) {
  bundler.spawn();
  if (await exists(icons)) await copyIcons();
  else console.warn(`no ${icons} yet; the icons are copied by the next one-shot bundle`);
} else {
  if (!(await bundler.output()).success) throw new Error('bundle failed');
  if (!(await exists(icons))) throw new Error(`missing ${icons}: is @tabler/icons in deno.jsonc imports?`);
  await copyIcons();
  for await (const entry of Deno.readDir(distDir)) {
    if (entry.isFile) console.log(`  ${entry.name.padEnd(45)} ${format((await Deno.stat(join(distDir, entry.name))).size)}`);
  }
}
