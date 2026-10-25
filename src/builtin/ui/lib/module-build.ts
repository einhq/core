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
 * - anything at all with `import type`, which is erased before bundling.
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
import { SHARED_GLOBAL, sharedSpecifiers, uiRuntime } from './shared.ts';
import { type ModuleBuild, type ModuleRoute, type ModuleUi, type SearchableKind, UI_CACHE_PATH, UI_MANIFEST_PATH, type UiManifest } from './ui-cache.ts';
import type { NodeTypeDoc } from '@ein/api';

/** Bumped when what a build produces changes for the same sources. */
const BUILD_FORMAT = 3;

const STAGE_ROOT = '/tmp/ein-ui';

type Manifest = {
  name: string;
  imports?: Record<string, string>;
  exports?: Record<string, string>;
  ui?: { routes?: Record<string, string>; open?: Record<string, string> };
  nodeTypes?: Partial<NodeTypeDoc>[];
};

/** The node types the Search page offers, from the module's `nodeTypes` marked `searchable`, as their readers call several. */
const searchableOf = (manifest: Manifest): SearchableKind[] =>
  (manifest.nodeTypes ?? []).flatMap((doc) =>
    doc?.searchable === true && typeof doc.type === 'string' && typeof doc.root === 'string'
      ? [{ kind: doc.type, label: typeof doc.plural === 'string' && doc.plural ? doc.plural : `${doc.label ?? doc.type}s` }]
      : []
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

/**
 * The module's UI sources, module-relative path → text: the pages and everything they import
 * of the module's own, and the aliases they reached it by.
 */
const collectSources = async (
  reader: Reader,
  modulePath: string,
  manifest: Manifest,
  routes: [string, string][],
  lent: Set<string>,
): Promise<{ sources: Map<string, string>; aliases: Map<string, string> }> => {
  const sources = new Map<string, string>();
  const aliases = new Map<string, string>();

  /** An own alias: `imports` (exact or a `/`-ended prefix) to a file in the module, or `@<name>/<export>`. */
  const ownTarget = (spec: string): string | undefined => {
    const imports = manifest.imports ?? {};
    let target: string | undefined = imports[spec];
    if (target === undefined) {
      const prefix = Object.keys(imports).filter((key) => key.endsWith('/') && spec.startsWith(key)).sort((a, b) => b.length - a.length)[0];
      if (prefix) target = imports[prefix] + spec.slice(prefix.length);
    }
    if (target === undefined && spec.startsWith(`@${manifest.name}/`)) target = manifest.exports?.[`./${spec.slice(manifest.name.length + 2)}`];
    return target !== undefined && isRelative(target) ? inside(target) : undefined;
  };

  const visit = async (rel: string, from: string): Promise<void> => {
    if (sources.has(rel)) return;
    const text = await reader.maybeText(`${modulePath}/${rel}`);
    if (text === undefined) throw new Error(`${from}: ${rel} does not exist`);
    sources.set(rel, text);
    if (!/\.(tsx?|jsx?|mjs)$/.test(rel)) return;

    for (const spec of specifiersOf(text)) {
      if (lent.has(spec)) continue;
      if (isRelative(spec)) {
        const target = inside(join(dirname(rel), spec));
        if (!target) throw new Error(`${rel}: '${spec}' leaves the module`);
        await visit(target, rel);
        continue;
      }
      const own = ownTarget(spec);
      if (own) {
        aliases.set(spec, own);
        await visit(own, rel);
        continue;
      }
      throw new Error(
        `${rel}: '${spec}' is neither lent by the shell nor the module's own; a module's pages import ` +
          `the shell's packages, the kit (@ein/ui/*) and their own files, and use 'import type' for types`,
      );
    }
  };

  for (const [path, page] of routes) await visit(page, `mod.json ui.routes['${path}']`);

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
  if (!/\.(tsx?|jsx?|mjs)$/.test(rel)) return text;
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
    const { sources, aliases } = await collectSources(reader, modulePath, manifest, routes, new Set(Object.keys(shared)));

    const search = searchableOf(manifest);
    const key = await sha256(JSON.stringify([
      BUILD_FORMAT,
      runtime.id,
      Deno.version.deno,
      module,
      manifest.ui,
      search,
      [...aliases].sort(),
      [...sources].sort(([a], [b]) => a.localeCompare(b)),
    ]));
    const previous = await readBuild(reader, module);
    if (previous?.key === key && await cmd.sys.vfs.exists(cmd.access, previous.url.replace(/^\/file/, ''))) {
      return { state: 'cached' };
    }

    // Stage: the module's files under m/, the shims under shared/, an import map over both. Each
    // build has a directory of its own: another instance or checkout on the host may be building
    // the same sources at the same time.
    await Deno.mkdir(STAGE_ROOT, { recursive: true });
    const stage = await Deno.makeTempDir({ dir: STAGE_ROOT, prefix: `${module}-` });
    staged = stage;
    for (const [rel, text] of sources) {
      const file = join(stage, 'm', stagedPath(module, rel));
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(file, rewriteCssModules(module, rel, text));
    }
    const importMap: Record<string, string> = {};
    await Deno.mkdir(join(stage, 'shared'), { recursive: true });
    Object.entries(shared).forEach(([specifier, names], index) => {
      const file = `./shared/${index}.${names === '*' ? 'cjs' : 'mjs'}`;
      Deno.writeTextFileSync(join(stage, file), shimSource(specifier, names));
      importMap[specifier] = file;
    });
    for (const [alias, target] of aliases) importMap[alias] = `./m/${stagedPath(module, target)}`;
    await Deno.writeTextFile(
      join(stage, 'deno.json'),
      JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' }, imports: importMap, lock: false, nodeModulesDir: 'none' }, null, 2),
    );

    const generated = generateEntry(module, routes);
    await Deno.writeTextFile(join(stage, 'entry.tsx'), generated.entry);

    const out = join(stage, 'out');
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'bundle',
        '--config',
        join(stage, 'deno.json'),
        '--platform',
        'browser',
        '--format',
        'esm',
        // Not --minify: it renames CSS-module classes to one or two letters, unique within a
        // bundle but not between them, and every module's stylesheet is in the same page.
        // A module's own few files cost little unminified.
        '--no-npm',
        '--no-remote',
        '--outdir',
        out,
        join(stage, 'entry.tsx'),
      ],
      stdout: 'piped',
      stderr: 'piped',
      env: { NO_COLOR: '1' },
    }).output();
    if (!result.success) {
      throw new Error(`deno bundle failed:\n${new TextDecoder().decode(result.stderr).replace(/^.*experimental.*\n/m, '').trim()}`);
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
    const build: ModuleBuild = {
      key,
      url: fileUrl(`${dir}/${jsName}`),
      ...(cssName ? { css: fileUrl(`${dir}/${cssName}`) } : {}),
      routes: generated.routes,
      ...(manifest.ui?.open ? { open: manifest.ui.open } : {}),
      ...(search.length ? { search } : {}),
    };
    await writeVfsFile(cmd, dir, 'build.json', new TextEncoder().encode(`${JSON.stringify(build, null, 2)}\n`), { mimetype: 'application/json' });

    // Earlier builds' files go; a page open since then reloads into the new one.
    for (const child of await cmd.sys.vfs.children(cmd.access, dir)) {
      if (![jsName, cssName, 'build.json'].includes(child.name)) await cmd.sys.vfs.unlink(cmd.access, `${dir}/${child.name}`, dir);
    }
    return { state: 'built', bytes: js.length + (css?.length ?? 0), ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staged) await Deno.remove(staged, { recursive: true }).catch(() => {});
  }
};

/**
 * Rewrite the manifest from every built module's `build.json`, keeping only `modules`
 * (those with `ui.routes`, installed now), and remove the directories of the rest.
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
    entries[module] = {
      url: build.url,
      ...(build.css ? { css: build.css } : {}),
      routes: build.routes,
      ...(build.open ? { open: build.open } : {}),
      ...(build.search ? { search: build.search } : {}),
    };
  }
  const manifest: UiManifest = { runtime: uiRuntime().id, modules: entries };
  await writeVfsFile(cmd, UI_CACHE_PATH, UI_MANIFEST_PATH.slice(UI_CACHE_PATH.length + 1), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), {
    mimetype: 'application/json',
  });
  return { manifest, conflicts };
};
