/**
 * Bundle one module's pages inside the running EiN, from its sources in the VFS.
 *
 * A module lists its routes in its mod.json, each path with the page file that draws it:
 * `"ui": { "routes": { "/devices": "ui/pages/devices.tsx", "/devices/:id": "ui/pages/device.tsx" } }`.
 * A page's default export is its component; it may also export `handle`, `loader`, `action`
 * and `ErrorBoundary`, which become the route's. The routes are what a module gives the UI
 * besides its navigation entries; an entry opens one as the page, in the shell's dialog, in its
 * drawer or full screen. A module route may sit under one of the shell's (`/albums/new` beside
 * the shell's `/albums`); one at the very path the shell has is never reached, as the shell's
 * own is matched first, and the shell warns of it. Two modules giving one path is refused when
 * the manifest is written. What the module may import is narrow on purpose:
 *
 * - what the shell lends (`SHARED_PACKAGES`, the kit as `@ein/ui/*`), read from the
 *   shell's runtime at load time, so there is one React;
 * - its own files, by relative path or through its own `imports` and `exports`, CSS included;
 * - what a module it lists in its `dependencies` exports (`@<dep>/<export>`), with that file's
 *   own imports, by the same rules: the dependency's files are bundled into this module's pages,
 *   so a change to them builds this module again;
 * - anything at all with `import type`, which is erased before bundling;
 * - a script EiN serves, by its path under `/file/` (`import('/file/usr/modules/<m>/glue.js')`),
 *   which is not bundled: the browser loads it when the import runs.
 *
 * A module may also give its pages Web Workers, each a script of its own named in `ui.workers`
 * (`"workers": { "solver": "ui/solver/worker.ts" }`), TypeScript or JavaScript. A worker is
 * bundled alone into one ES module for a dedicated worker, and imports by the same rules but for
 * the first: the shell lends a worker nothing, as a worker has no page to read it from. A page
 * starts one with the kit's `moduleWorker`.
 *
 * No npm and no network: a build is the module's own few files, so it is quick and needs little
 * memory.
 *
 * The sources are read from the VFS (the module directory is wherever the install put it),
 * staged to disk, and given to `deno bundle` with an import map that sends every lent
 * specifier to a one-line shim reading `globalThis.__EIN_UI__`. The result is stored under
 * `/var/cache/ui/<module>/` with the build's key, so an unchanged module is not rebuilt.
 */

import type { Command } from '@ein/client';
import { NodeNotFoundError } from '@ein/client';
import { dirname, join, normalize } from '@std/path';
import { toText } from '@std/streams/to-text';
import { moduleGroupGids } from '../../../modules/audience.ts';
import { SHARED_GLOBAL, sharedSpecifiers, uiRuntime } from './shared.ts';
import {
  type ModuleBuild,
  type ModuleRoute,
  type ModuleUi,
  type NodeTypeLook,
  type SearchableKind,
  UI_CACHE_PATH,
  UI_LICENCES_PATH,
  UI_MANIFEST_PATH,
  type UiManifest,
} from './ui-cache.ts';
import type { NodeTypeDoc } from '@ein/api';

/** Bumped when what a build produces changes for the same sources. */
const BUILD_FORMAT = 4;

const STAGE_ROOT = '/tmp/ein-ui';

type Manifest = {
  name: string;
  imports?: Record<string, string>;
  exports?: Record<string, string>;
  ui?: { routes?: Record<string, string>; open?: Record<string, string>; shareLinks?: ModuleUi['shareLinks']; workers?: Record<string, string> };
  nodeTypes?: Partial<NodeTypeDoc>[];
};

/** The node types the Search page offers, from the module's `nodeTypes` marked `searchable`, as their readers call several. */
const searchableOf = (manifest: Manifest): SearchableKind[] =>
  (manifest.nodeTypes ?? []).flatMap((doc) =>
    doc?.searchable === true && typeof doc.type === 'string' && typeof doc.root === 'string'
      ? [{ kind: doc.type, label: typeof doc.plural === 'string' && doc.plural ? doc.plural : `${doc.label ?? doc.type}s` }]
      : []
  );

/** Each of the module's `nodeTypes` with a label: its noun (the label in lower case when it names none) and its pages' pattern. */
const typesOf = (manifest: Manifest): Record<string, NodeTypeLook> =>
  Object.fromEntries(
    (manifest.nodeTypes ?? []).flatMap((doc) =>
      typeof doc?.type === 'string' && typeof doc.label === 'string'
        ? [[doc.type, {
          noun: typeof doc.noun === 'string' && doc.noun ? doc.noun : doc.label.toLowerCase(),
          ...(typeof doc.pattern === 'string' && doc.pattern ? { pattern: doc.pattern } : {}),
        }]]
        : []
    ),
  );

export type BuildOutcome =
  | { state: 'built'; bytes: number; ms: number }
  | { state: 'cached' }
  | { state: 'failed'; error: string };

/** Specifier positions: a from-clause, a dynamic import and a side-effect import. */
const SPECIFIER_PATTERNS = [
  /(\bfrom\s+)(['"])([^'"]+)\2/g,
  /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
  /(^|[\s;])(import\s+)(['"])([^'"]+)\3/gm,
];

/** `import type …` and `export type … from`: erased by the bundler, never resolved. */
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;]*?\bfrom\s+(['"])[^'"]+\1;?/g;

const specifiersOf = (source: string): string[] => {
  const code = source.replace(TYPE_ONLY, '');
  return [...new Set(SPECIFIER_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[m.length - 1])))];
};

const isRelative = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../');

/** A module-relative path, or `undefined` when it would leave the module. */
const inside = (path: string): string | undefined => {
  const n = normalize(path).replace(/^\.\//, '');
  return n.startsWith('../') || n === '..' || n.startsWith('/') ? undefined : n;
};

const sha256 = async (data: Uint8Array | string): Promise<string> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

class Reader {
  constructor(private cmd: Command) {}

  async text(path: string): Promise<string> {
    const handle = await this.cmd.sys.vfs.open(this.cmd.access, path, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  }

  async maybeText(path: string): Promise<string | undefined> {
    try {
      return await this.text(path);
    } catch (error) {
      if (error instanceof NodeNotFoundError) return undefined;
      throw error;
    }
  }
}

/** A route path: absolute, of literal and `:param` segments. `/` itself is the shell's home page. */
const ROUTE_PATH = /^(\/(:?[A-Za-z0-9_.~-]+))+$/;

/** The module's routes as `[path, page]`, by path; a malformed one is an error (`mod setup` refuses them first). */
const routesOf = (manifest: Manifest): [string, string][] => {
  const routes = manifest.ui?.routes;
  if (!routes || typeof routes !== 'object' || Object.keys(routes).length === 0) throw new Error('mod.json has no ui.routes');
  return Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => {
    if (!ROUTE_PATH.test(path)) throw new Error(`ui.routes: '${path}' is not a path below '/' of literal and :param segments`);
    const page = typeof file === 'string' && file.endsWith('.tsx') ? inside(file) : undefined;
    if (!page) throw new Error(`ui.routes['${path}']: '${file}' is not a .tsx file inside the module`);
    return [path, page];
  });
};

/** A worker's name: what `moduleWorker` asks for, and the start of its script's file name. */
const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The module's workers as `[name, script]`, by name; a malformed one is an error (`mod setup` refuses them first). */
const workersOf = (manifest: Manifest): [string, string][] => {
  const workers = manifest.ui?.workers;
  if (workers === undefined) return [];
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) throw new Error("ui.workers must map a worker's name to its script");
  return Object.entries(workers).sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => {
    if (!WORKER_NAME.test(name)) throw new Error(`ui.workers: '${name}' is not a name of letters, digits, - and _`);
    const script = typeof file === 'string' && /\.(ts|js|mjs)$/.test(file) ? inside(file) : undefined;
    if (!script) throw new Error(`ui.workers['${name}']: '${file}' is not a .ts or .js file inside the module`);
    return [name, script];
  });
};

/** Where EiN serves its files: a specifier under it is the browser's to load, not the bundle's. */
const SERVED = '/file/';

/** Scripts a bundle is made of; anything else a source imports is a stylesheet. */
const SCRIPT = /\.(tsx?|jsx?|mjs)$/;

/**
 * The module's UI sources for one bundle, module-relative path → text: its entries (the pages, or
 * a worker's script) and everything they import of the module's own, and the aliases they reached
 * it by. `lent` is what the shell lends the bundle: nothing, to a worker.
 */
const collectSources = async (
  reader: Reader,
  modulePath: string,
  manifest: Manifest,
  entries: { file: string; from: string }[],
  lent: Set<string>,
): Promise<{ sources: Map<string, string>; aliases: Map<string, string> }> => {
  const sources = new Map<string, string>();
  const aliases = new Map<string, string>();
  const modulesPath = dirname(modulePath);
  /** The modules whose files a page reaches: this one, then each dependency once read, staged under `.deps/<name>/`. */
  const owners = new Map<string, { manifest: Manifest; path: string; prefix: string }>([[manifest.name, { manifest, path: modulePath, prefix: '' }]]);
  const dependency = async (name: string) => {
    if (!owners.has(name)) {
      const path = `${modulesPath}/${name}`;
      const text = await reader.maybeText(`${path}/mod.json`);
      if (text === undefined) return undefined;
      owners.set(name, { manifest: JSON.parse(text) as Manifest, path, prefix: `.deps/${name}/` });
    }
    return owners.get(name);
  };

  /** An alias of `owner`'s: its `imports` (exact or a `/`-ended prefix) to a file of its own, `@<name>/<export>`, or a dependency's export; a staged path. */
  const target = async (owner: string, spec: string): Promise<string | undefined> => {
    const { manifest: own, prefix } = owners.get(owner)!;
    const imports = own.imports ?? {};
    let found: string | undefined = imports[spec];
    if (found === undefined) {
      const key = Object.keys(imports).filter((each) => each.endsWith('/') && spec.startsWith(each)).sort((a, b) => b.length - a.length)[0];
      if (key) found = imports[key] + spec.slice(key.length);
    }
    if (found === undefined && spec.startsWith(`@${own.name}/`)) found = own.exports?.[`./${spec.slice(own.name.length + 2)}`];
    if (found !== undefined) {
      const rel = isRelative(found) ? inside(found) : undefined;
      return rel === undefined ? undefined : `${prefix}${rel}`;
    }
    const match = /^@([^/]+)\/(.+)$/.exec(spec);
    const deps = (own as { dependencies?: Record<string, string> }).dependencies ?? {};
    if (!match || !(match[1] in deps)) return undefined;
    const dep = await dependency(match[1]);
    const exported = dep?.manifest.exports?.[`./${match[2]}`];
    const rel = exported !== undefined && isRelative(exported) ? inside(exported) : undefined;
    return rel === undefined || !dep ? undefined : `${dep.prefix}${rel}`;
  };

  /** The module a staged path is a file of. */
  const ownerOf = (staged: string): string => staged.startsWith('.deps/') ? staged.split('/')[1] : manifest.name;

  const visit = async (staged: string, from: string): Promise<void> => {
    if (sources.has(staged)) return;
    const owner = owners.get(ownerOf(staged))!;
    const rel = staged.slice(owner.prefix.length);
    const text = await reader.maybeText(`${owner.path}/${rel}`);
    if (text === undefined) throw new Error(`${from}: ${staged} does not exist`);
    sources.set(staged, text);
    if (!SCRIPT.test(rel)) return;

    for (const spec of specifiersOf(text)) {
      if (lent.has(spec) || spec.startsWith(SERVED)) continue;
      if (isRelative(spec)) {
        const next = inside(join(dirname(rel), spec));
        if (!next) throw new Error(`${staged}: '${spec}' leaves the module`);
        await visit(`${owner.prefix}${next}`, staged);
        continue;
      }
      const aliased = await target(ownerOf(staged), spec);
      if (aliased) {
        // One import map serves every file of the bundle, so an alias means one file wherever it is used.
        const known = aliases.get(spec);
        if (known !== undefined && known !== aliased) throw new Error(`${staged}: '${spec}' is ${aliased} here and ${known} elsewhere in the same pages`);
        aliases.set(spec, aliased);
        await visit(aliased, staged);
        continue;
      }
      throw new Error(
        lent.size > 0
          ? `${staged}: '${spec}' is neither lent by the shell nor the module's own; a module's pages import ` +
            `the shell's packages, the kit (@ein/ui/*) and their own files, and use 'import type' for types`
          : `${staged}: '${spec}' is not the module's own; a worker imports its module's own files and what ` +
            `its dependencies export, as the shell lends a worker nothing, and uses 'import type' for types`,
      );
    }
  };

  for (const { file, from } of entries) await visit(file, from);

  return { sources, aliases };
};

/**
 * Stage path for a source: CSS modules carry the module's name, since the bundler names
 * their classes after the file alone and two modules' `card.module.css` would otherwise
 * share class names in one page.
 */
const stagedPath = (module: string, rel: string): string => rel.endsWith('.module.css') ? join(dirname(rel), `${module}-${rel.split('/').pop()}`) : rel;

/** A source with its relative specifiers pointed at renamed CSS modules. */
const rewriteCssModules = (module: string, rel: string, text: string): string => {
  if (!SCRIPT.test(rel)) return text;
  return text.replace(/(['"])(\.{1,2}\/[^'"]*\.module\.css)\1/g, (_whole, quote: string, spec: string) => {
    const file = spec.split('/').pop()!;
    return `${quote}${spec.slice(0, -file.length)}${module}-${file}${quote}`;
  });
};

/**
 * The bundle's entry: every route's parts by route id, from its page's exports. The parts a page
 * does not export are left out rather than set to `undefined`, which the router would take as
 * the route's own.
 */
const generateEntry = (module: string, routes: [string, string][]): { entry: string; routes: ModuleRoute[] } => {
  const imports: string[] = [];
  const lines = [
    `const route = (page: Record<string, unknown>) => {`,
    `  const parts: Record<string, unknown> = { Component: page.default };`,
    `  for (const name of ['handle', 'loader', 'action', 'ErrorBoundary']) if (page[name] !== undefined) parts[name] = page[name];`,
    `  return parts;`,
    `};`,
  ];
  const defs: string[] = [];
  const out: ModuleRoute[] = [];
  routes.forEach(([path, page], index) => {
    const id = `${module}:${path}`;
    // The specifier as JSON, not quoted in place: core's TS loader reads a quoted relative `from` here as this file's own import.
    imports.push(`import * as page${index} from ${JSON.stringify(`./m/${page}`)};`);
    defs.push(`  ${JSON.stringify(id)}: route(page${index}),`);
    out.push({ id, path });
  });
  lines.push('', 'export const routes: Record<string, Record<string, unknown>> = {', ...defs, '};');
  return { entry: `${[...imports, ...lines].join('\n')}\n`, routes: out };
};

/** One shim per lent specifier: CommonJS for a whole namespace, named exports for a list. */
const shimSource = (specifier: string, names: '*' | readonly string[]): string => {
  const read = `globalThis[${JSON.stringify(SHARED_GLOBAL)}][${JSON.stringify(specifier)}]`;
  if (names === '*') return `module.exports = ${read};\n`;
  return `const shared = ${read};\n${names.map((name) => `export const ${name} = shared.${name};`).join('\n')}\n`;
};

const writeVfsFile = async (cmd: Command, dir: string, name: string, data: Uint8Array, attrs: Record<string, unknown>): Promise<void> => {
  const path = `${dir}/${name}`;
  if (!await cmd.sys.vfs.exists(cmd.access, path)) {
    await cmd.sys.vfs.create(cmd.access, 'file', dir, name, { props: { mode: 0o644 } });
  }
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
  await cmd.sys.vfs.update(cmd.access, path, { attrs: { ...attrs, size: data.length } });
};

const ensureDir = async (cmd: Command, parent: string, name: string): Promise<void> => {
  await cmd.sys.vfs.ensure(cmd.access, 'directory', parent, name, { props: { mode: 0o755 } });
};

const ensureCacheDir = async (cmd: Command, module?: string): Promise<void> => {
  await ensureDir(cmd, '/var', 'cache');
  await ensureDir(cmd, '/var/cache', 'ui');
  if (module) await ensureDir(cmd, UI_CACHE_PATH, module);
};

const readBuild = async (reader: Reader, module: string): Promise<ModuleBuild | undefined> => {
  const text = await reader.maybeText(`${UI_CACHE_PATH}/${module}/build.json`);
  if (!text) return undefined;
  try {
    const build = JSON.parse(text) as ModuleBuild;
    // A build whose routes are not absolute paths is not of this format; ui-build makes it again.
    return build.routes.every((route) => route.path?.startsWith('/')) ? build : undefined;
  } catch {
    return undefined;
  }
};

const fileUrl = (path: string): string => `/file${path}`;

/** Write a bundle's sources under `<dir>/m/` and its import map, of `aliases` and `imports`, to `<dir>/deno.json`. */
const stageSources = async (
  dir: string,
  module: string,
  sources: Map<string, string>,
  aliases: Map<string, string>,
  imports: Record<string, string>,
): Promise<string> => {
  for (const [rel, text] of sources) {
    const file = join(dir, 'm', stagedPath(module, rel));
    await Deno.mkdir(dirname(file), { recursive: true });
    await Deno.writeTextFile(file, rewriteCssModules(module, rel, text));
  }
  const importMap = { ...imports };
  for (const [alias, target] of aliases) importMap[alias] = `./m/${stagedPath(module, target)}`;
  const config = join(dir, 'deno.json');
  await Deno.writeTextFile(
    config,
    JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' }, imports: importMap, lock: false, nodeModulesDir: 'none' }, null, 2),
  );
  return config;
};

/** `deno bundle` one entry into an ES module for the browser, at `output` (`--output`) or in `outdir`. */
const bundle = async (config: string, entry: string, out: { output: string } | { outdir: string }): Promise<void> => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'bundle',
      '--config',
      config,
      '--platform',
      'browser',
      '--format',
      'esm',
      // Not --minify: it renames CSS-module classes to one or two letters, unique within a
      // bundle but not between them, and every module's stylesheet is in the same page.
      // A module's own few files cost little unminified.
      '--no-npm',
      '--no-remote',
      '--external',
      `${SERVED}*`,
      ...('output' in out ? ['--output', out.output] : ['--outdir', out.outdir]),
      entry,
    ],
    stdout: 'piped',
    stderr: 'piped',
    env: { NO_COLOR: '1' },
  }).output();
  if (!result.success) {
    throw new Error(`deno bundle failed:\n${new TextDecoder().decode(result.stderr).replace(/^.*experimental.*\n/m, '').trim()}`);
  }
};

/** A worker's sources, as `collectSources` gives them for its script alone. */
type WorkerSources = { name: string; script: string; sources: Map<string, string>; aliases: Map<string, string> };

/**
 * Build one module's bundle unless an identical one is stored.
 */
export const buildModuleUi = async (cmd: Command, modulePath: string): Promise<BuildOutcome> => {
  const started = performance.now();
  const reader = new Reader(cmd);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await reader.text(`${modulePath}/mod.json`)) as Manifest;
  } catch (error) {
    return { state: 'failed', error: `mod.json: ${error instanceof Error ? error.message : String(error)}` };
  }
  const module = manifest.name;

  let staged: string | undefined;
  try {
    const routes = routesOf(manifest);
    const runtime = uiRuntime();
    const shared = sharedSpecifiers();
    const pages = routes.map(([path, page]) => ({ file: page, from: `mod.json ui.routes['${path}']` }));
    const { sources, aliases } = await collectSources(reader, modulePath, manifest, pages, new Set(Object.keys(shared)));
    const workers: WorkerSources[] = [];
    for (const [name, script] of workersOf(manifest)) {
      const collected = await collectSources(reader, modulePath, manifest, [{ file: script, from: `mod.json ui.workers['${name}']` }], new Set());
      const sheet = [...collected.sources.keys()].find((rel) => !SCRIPT.test(rel));
      if (sheet) throw new Error(`ui.workers['${name}']: ${sheet} is not a script; a worker has no page to style`);
      workers.push({ name, script, ...collected });
    }

    const search = searchableOf(manifest);
    const types = typesOf(manifest);
    const key = await sha256(JSON.stringify([
      BUILD_FORMAT,
      runtime.id,
      Deno.version.deno,
      module,
      manifest.ui,
      search,
      types,
      [...aliases].sort(),
      [...sources].sort(([a], [b]) => a.localeCompare(b)),
      workers.map((worker) => [worker.name, [...worker.aliases].sort(), [...worker.sources].sort(([a], [b]) => a.localeCompare(b))]),
    ]));
    const previous = await readBuild(reader, module);
    const stored = async (url: string) => await cmd.sys.vfs.exists(cmd.access, url.replace(/^\/file/, ''));
    if (previous?.key === key && await stored(previous.url) && (await Promise.all(Object.values(previous.workers ?? {}).map(stored))).every(Boolean)) {
      return { state: 'cached' };
    }

    // Stage: the module's files under m/, the shims under shared/, an import map over both; each
    // worker the same under workers/<name>/, without shims. Each build has a directory of its own:
    // another instance or checkout on the host may be building the same sources at the same time.
    await Deno.mkdir(STAGE_ROOT, { recursive: true });
    const stage = await Deno.makeTempDir({ dir: STAGE_ROOT, prefix: `${module}-` });
    staged = stage;
    const shims: Record<string, string> = {};
    await Deno.mkdir(join(stage, 'shared'), { recursive: true });
    Object.entries(shared).forEach(([specifier, names], index) => {
      const file = `./shared/${index}.${names === '*' ? 'cjs' : 'mjs'}`;
      Deno.writeTextFileSync(join(stage, file), shimSource(specifier, names));
      shims[specifier] = file;
    });
    const config = await stageSources(stage, module, sources, aliases, shims);

    const generated = generateEntry(module, routes);
    await Deno.writeTextFile(join(stage, 'entry.tsx'), generated.entry);
    const out = join(stage, 'out');
    await bundle(config, join(stage, 'entry.tsx'), { outdir: out });

    const workerOut = new Map<string, Uint8Array>();
    for (const worker of workers) {
      const dir = join(stage, 'workers', worker.name);
      const workerConfig = await stageSources(dir, module, worker.sources, worker.aliases, {});
      const output = join(dir, 'out.js');
      await bundle(workerConfig, join(dir, 'm', worker.script), { output });
      workerOut.set(worker.name, await Deno.readFile(output));
    }

    const js = await Deno.readFile(join(out, 'entry.js'));
    const css = await Deno.readFile(join(out, 'entry.css')).catch(() => undefined);
    await ensureCacheDir(cmd, module);
    const dir = `${UI_CACHE_PATH}/${module}`;
    const jsHash = await sha256(js);
    const jsName = `${jsHash.slice(0, 12)}.js`;
    await writeVfsFile(cmd, dir, jsName, js, { mimetype: 'text/javascript', sha256: jsHash, immutable: true });
    let cssName: string | undefined;
    if (css && css.length > 0) {
      const cssHash = await sha256(css);
      cssName = `${cssHash.slice(0, 12)}.css`;
      await writeVfsFile(cmd, dir, cssName, css, { mimetype: 'text/css', sha256: cssHash, immutable: true });
    }
    const workerUrls: Record<string, string> = {};
    for (const [name, bytes] of workerOut) {
      const hash = await sha256(bytes);
      const fileName = `${name}-${hash.slice(0, 12)}.js`;
      await writeVfsFile(cmd, dir, fileName, bytes, { mimetype: 'text/javascript', sha256: hash, immutable: true });
      workerUrls[name] = fileUrl(`${dir}/${fileName}`);
    }
    const build: ModuleBuild = {
      key,
      url: fileUrl(`${dir}/${jsName}`),
      ...(cssName ? { css: fileUrl(`${dir}/${cssName}`) } : {}),
      routes: generated.routes,
      ...(workers.length ? { workers: workerUrls } : {}),
      ...(manifest.ui?.open ? { open: manifest.ui.open } : {}),
      ...(manifest.ui?.shareLinks ? { shareLinks: manifest.ui.shareLinks } : {}),
      ...(search.length ? { search } : {}),
      ...(Object.keys(types).length ? { types } : {}),
    };
    await writeVfsFile(cmd, dir, 'build.json', new TextEncoder().encode(`${JSON.stringify(build, null, 2)}\n`), { mimetype: 'application/json' });

    // Earlier builds' files go; a page open since then reloads into the new one.
    const kept = new Set([jsName, cssName, 'build.json', ...Object.values(workerUrls).map((url) => url.slice(url.lastIndexOf('/') + 1))]);
    for (const child of await cmd.sys.vfs.children(cmd.access, dir)) {
      if (!kept.has(child.name)) await cmd.sys.vfs.unlink(cmd.access, `${dir}/${child.name}`, dir);
    }
    const workerBytes = [...workerOut.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    return { state: 'built', bytes: js.length + (css?.length ?? 0) + workerBytes, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staged) await Deno.remove(staged, { recursive: true }).catch(() => {});
  }
};

/** What the stored third-party notices of the installation were made from (`writeLicencesFile`), if any are stored. */
export const storedLicencesKey = async (cmd: Command): Promise<string | undefined> => {
  try {
    const key = (await cmd.sys.vfs.get(cmd.access, UI_LICENCES_PATH)).attrs?.key;
    return typeof key === 'string' ? key : undefined;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

/** Store the installation's third-party notices, made from `key` (`storedLicencesKey`). */
export const writeLicencesFile = async (cmd: Command, text: string, key: string): Promise<void> => {
  await ensureCacheDir(cmd);
  await writeVfsFile(cmd, UI_CACHE_PATH, UI_LICENCES_PATH.slice(UI_CACHE_PATH.length + 1), new TextEncoder().encode(text), { mimetype: 'text/plain', key });
};

/**
 * Rewrite the manifest from every built module's `build.json`, keeping only `modules`
 * (those with `ui.routes`, installed now), and remove the directories of the rest. The manifest
 * names the installation's third-party notices when they are stored.
 *
 * A path is one module's: a module giving a path an earlier one (by name) already has is left
 * out of the manifest, and returned in `conflicts` with why.
 */
export const writeUiManifest = async (cmd: Command, modules: string[]): Promise<{ manifest: UiManifest; conflicts: Record<string, string> }> => {
  const reader = new Reader(cmd);
  await ensureCacheDir(cmd);
  const wanted = new Set(modules);
  const builds: [string, ModuleBuild][] = [];
  for (const child of await cmd.sys.vfs.children(cmd.access, UI_CACHE_PATH)) {
    if (child.node.type !== 'directory') continue;
    if (!wanted.has(child.name)) {
      await cmd.sys.vfs.unlink(cmd.access, `${UI_CACHE_PATH}/${child.name}`, UI_CACHE_PATH, { recursive: true });
      continue;
    }
    const build = await readBuild(reader, child.name);
    if (build) builds.push([child.name, build]);
  }

  const owner = new Map<string, string>();
  const entries: Record<string, ModuleUi> = {};
  const conflicts: Record<string, string> = {};
  for (const [module, build] of builds.sort(([a], [b]) => a.localeCompare(b))) {
    const taken = build.routes.find((route) => owner.has(route.path));
    if (taken) {
      conflicts[module] = `${taken.path} is ${owner.get(taken.path)}'s route already`;
      continue;
    }
    for (const route of build.routes) owner.set(route.path, module);
    const gids = await moduleGroupGids(cmd.sys.vfs, module);
    entries[module] = {
      url: build.url,
      ...(build.css ? { css: build.css } : {}),
      routes: build.routes,
      ...(build.workers ? { workers: build.workers } : {}),
      ...(build.open ? { open: build.open } : {}),
      ...(build.shareLinks ? { shareLinks: build.shareLinks } : {}),
      ...(build.search ? { search: build.search } : {}),
      ...(build.types ? { types: build.types } : {}),
      ...(gids ? { gids } : {}),
    };
  }
  const licences = await cmd.sys.vfs.exists(cmd.access, UI_LICENCES_PATH);
  const manifest: UiManifest = { runtime: uiRuntime().id, modules: entries, ...(licences ? { licences: fileUrl(UI_LICENCES_PATH) } : {}) };
  await writeVfsFile(cmd, UI_CACHE_PATH, UI_MANIFEST_PATH.slice(UI_CACHE_PATH.length + 1), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), {
    mimetype: 'application/json',
  });
  return { manifest, conflicts };
};
