/**
 * Staging and specifier rewriting for `#!ts` module commands.
 *
 * A `#!ts` bin lives in the VFS, which Deno cannot import from, so it is run by handing Deno a copy
 * and dynamically importing that. The copy's imports would be resolved by whatever import map the
 * *process* started with — core's `deno.jsonc`. A module cannot add an entry to a map that was
 * read before it was installed, and there is no per-directory scope to hang one on because the
 * copy is not in the module.
 *
 * So the specifiers are resolved here instead, before the copy is made, by the rule in
 * `src/modules/resolve.ts`:
 *
 *   - a bare specifier is looked up in the owning module's own `imports`, then its own `exports`,
 *     then the `exports` of a module it lists in `dependencies` — `@ems/client` from archive
 *     is ems's `./client` export, read from the *installed* ems module. `jsr:`, `npm:`
 *     and `http(s):` targets are schemes Deno resolves with no import map at all, which is what
 *     makes runtime install work.
 *   - a bare specifier the rule does not claim is left alone, so core's base map still supplies
 *     `@ein/client` without every manifest having to restate it. One that names an installed
 *     module the owner does not depend on, or a path that module does not export, is an error.
 *   - relative specifiers resolve against the importing file's own directory, and the file they
 *     point at is staged too, recursively.
 *   - a type-only import or re-export is erased before the module runs, so it is left as written
 *     and its target is not staged.
 *
 * Every file is rewritten with **its own module's** manifest, whichever bin reached it. A
 * provider's internal aliases are therefore its own business — `@archive/people/person`
 * importing `@archive/people/genealogy` needs nothing from assistant, which imports it — and a
 * file stages to the same copy whichever dependent got there first, so a class like `EmsError`
 * is one class per process and `instanceof` holds across modules.
 *
 * Staging the whole local graph rather than pointing at the module's host path is deliberate: a
 * module's `lib/*.ts` would otherwise have its own bare specifiers resolved by the process map,
 * which is the very thing being avoided.
 *
 * The copies are `blob:` URLs in this process's memory and are never written to disk, so no other
 * process or user can read one, replace one before it is imported, or leave one behind for a
 * later process to pick up. A copy is identified by its VFS path and its rewritten body, which
 * embeds the URLs of everything it imports: an unchanged file keeps its URL, and Deno's module
 * cache, which is keyed by URL, keeps hitting, while an edited lib gives itself and every file
 * that reaches it a URL the process has not imported. Because a body embeds its imports' URLs,
 * value imports cannot form a cycle; one is refused with the files that form it.
 *
 * All of that runs once per bin per process, not once per invocation — see `loadTsCommand`.
 * Editing a *bin* takes effect immediately. **Editing a module's `lib/` or its `mod.json` takes
 * effect when a bin that reaches it is next staged** — when the bin itself changes, after `mod
 * setup`, or in a new process — because the loaded command is kept against the bin's node alone.
 */

import { dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import type { Access } from '../../lib/access/mod.ts';
import type { CmdFunction } from '../exec/mod.ts';
import type { Node, NodeVFS } from '../../vfs/mod.ts';
import type { FileAttrs } from '../../vfs/types/file.ts';
import { readModJson, resolveModuleSpecifier } from '../../modules/mod.ts';
import type { ModuleManifest } from '../../modules/mod.ts';

/**
 * Specifier positions in a module: `from '…'`, a side-effect `import '…'`, and `import('…')`.
 *
 * A regex rather than a parse because this only has to recognise import *positions*, and every
 * one of them in this codebase is a plain literal — a specifier built at runtime could not be
 * rewritten by any means short of running the module anyway.
 */
const SPECIFIER_PATTERNS = [
  /(\bfrom\s+)(['"])([^'"]+)\2/g,
  /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
  /(^|[\s;])(import\s+)(['"])([^'"]+)\3/gm,
];

/**
 * A type-only import or re-export: `import type { A } from '…'`, `import type * as ns from '…'`,
 * `import type A from '…'`, `export type { A } from '…'`, `export type * from '…'`. Narrow on
 * purpose: a type-only statement it misses is staged like a value import, which is harmless,
 * while a value import it mistook for one would be left unresolved.
 */
const TYPE_ONLY_PATTERN = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s+from\s+(['"])[^'"]+\1/g;

const isRelative = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../');

/** True for anything Deno resolves on its own, with or without an import map. */
const isAbsoluteSpecifier = (spec: string): boolean => /^(jsr|npm|node|https?|file|data|blob):/.test(spec);

/** True for a specifier Deno fetches from a registry or the network: what `mod cache` pre-fetches. */
const isPackageSpecifier = (spec: string): boolean => /^(jsr|npm|https?):/.test(spec);

const hash = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

/** Which module a command path belongs to: `/modules/<name>/bin/<cmd>` -> `/modules/<name>`. */
export const moduleRootOf = (commandPath: string, modulesPath: string): string | undefined => {
  const prefix = `${modulesPath.replace(/\/$/, '')}/`;
  if (!commandPath.startsWith(prefix)) return undefined;

  const name = commandPath.slice(prefix.length).split('/')[0];
  return name ? `${prefix}${name}` : undefined;
};

type StageContext = {
  vfs: NodeVFS;
  access: Access;
  modulesPath: string;
  /** Manifests read so far, by module name; null when no such module is installed. */
  manifests: Map<string, ModuleManifest | null>;
  /** VFS path -> staged URL, so a diamond in the import graph is staged once. */
  staged: Map<string, string>;
  /** The files being staged, outermost first: an import of one of them is a cycle. */
  stack: string[];
  /** Bodies already read by the caller, so the entry command is not fetched from the VFS twice. */
  sources: Map<string, string>;
  /** Every registry or network specifier the staged files import. */
  packages: Set<string>;
};

/** The installed module's manifest, read once per staging. */
const manifestOf = async (ctx: StageContext, name: string): Promise<ModuleManifest | null> => {
  if (!ctx.manifests.has(name)) {
    ctx.manifests.set(name, await readModJson(ctx.vfs, ctx.access, join(ctx.modulesPath, name)));
  }
  return ctx.manifests.get(name) ?? null;
};

/** The module a staged file belongs to, with its manifest and every manifest its resolution may consult. */
const ownerOf = async (ctx: StageContext, vfsPath: string): Promise<{ root: string; manifest: ModuleManifest } | undefined> => {
  const root = moduleRootOf(vfsPath, ctx.modulesPath);
  if (!root) return undefined;

  const manifest = await manifestOf(ctx, root.slice(root.lastIndexOf('/') + 1));
  if (!manifest) return undefined;

  for (const dep of Object.keys(manifest.dependencies ?? {})) await manifestOf(ctx, dep);
  return { root, manifest };
};

/** Synchronous lookup over what `manifestOf` has read, which is what the resolver takes. */
const lookupIn = (ctx: StageContext) => (name: string): ModuleManifest | undefined => ctx.manifests.get(name) ?? undefined;

/**
 * Staged copies by VFS path and a hash of the rewritten body, so an unchanged file keeps its URL
 * and Deno's module cache keeps hitting. Never revoked: a URL staged but not yet imported, as by
 * `mod cache`, is imported by the next staging that reaches the same body.
 */
const stagedUrls = new Map<string, string>();

/**
 * Stage one VFS TypeScript file and everything it reaches by import.
 *
 * Returns the URL of the staged copy.
 */
const stageFile = async (ctx: StageContext, vfsPath: string): Promise<string> => {
  const existing = ctx.staged.get(vfsPath);
  if (existing) return existing;

  if (ctx.stack.includes(vfsPath)) {
    const cycle = [...ctx.stack.slice(ctx.stack.indexOf(vfsPath)), vfsPath].join(' -> ');
    throw new Error(`import cycle in a #!ts command: ${cycle}; only type-only imports may form a cycle`);
  }

  let source = ctx.sources.get(vfsPath);
  if (source === undefined) {
    const handle = await ctx.vfs.open(ctx.access, vfsPath, { mode: 'r' });
    try {
      source = await toText(handle.readable);
    } finally {
      await handle.close();
    }
  }

  if (source.startsWith('#!ts')) source = source.slice(source.indexOf('\n') + 1);

  const owner = await ownerOf(ctx, vfsPath);

  ctx.stack.push(vfsPath);
  let rewritten: string;
  try {
    rewritten = await rewriteSpecifiers(ctx, source, dirname(vfsPath), owner);
  } finally {
    ctx.stack.pop();
  }

  // No await between the lookup and the insert, so two stagings of the same body that run
  // concurrently end up with one URL, and so one module.
  const key = `${vfsPath}\0${await hash(rewritten)}`;
  let url = stagedUrls.get(key);
  if (!url) {
    url = URL.createObjectURL(new Blob([rewritten], { type: 'application/typescript' }));
    stagedUrls.set(key, url);
  }

  ctx.staged.set(vfsPath, url);
  return url;
};

/** Rewrite every specifier in `source`, staging local files as it goes. */
const rewriteSpecifiers = async (
  ctx: StageContext,
  source: string,
  fromDir: string,
  owner: { root: string; manifest: ModuleManifest } | undefined,
): Promise<string> => {
  // Collect first, resolve second: the resolution is async and String.replace is not. Only value
  // imports are collected; a specifier that appears in nothing but type-only statements is left
  // as written by the replacement below.
  const resolved = new Map<string, string>();

  const valueSource = source.replace(TYPE_ONLY_PATTERN, '');
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of valueSource.matchAll(pattern)) {
      const spec = match[match.length - 1];
      if (!resolved.has(spec)) resolved.set(spec, spec);
    }
  }

  for (const spec of [...resolved.keys()]) {
    if (isAbsoluteSpecifier(spec)) {
      if (isPackageSpecifier(spec)) ctx.packages.add(spec);
      continue;
    }

    // A relative specifier points at a file beside this one: stage it and point at the copy.
    if (isRelative(spec)) {
      resolved.set(spec, await stageFile(ctx, join(fromDir, spec)));
      continue;
    }

    // A file with no module manifest above it has nothing to resolve against.
    if (!owner) continue;

    // A specifier naming another module is only an error if that module is installed, so read it
    // before resolving — the resolver itself is synchronous.
    const scope = spec.match(/^@([a-z0-9][a-z0-9-]*)\//)?.[1];
    if (scope && scope !== owner.manifest.name) await manifestOf(ctx, scope);

    const resolution = resolveModuleSpecifier(spec, owner.manifest, lookupIn(ctx));
    switch (resolution.kind) {
      case 'core':
        continue; // core's base map owns it (@ein/client, @ein/paths)
      case 'error':
        throw new Error(resolution.message);
      case 'import':
        if (isPackageSpecifier(resolution.target)) ctx.packages.add(resolution.target);
        resolved.set(
          spec,
          isAbsoluteSpecifier(resolution.target) ? resolution.target : await stageFile(ctx, join(owner.root, resolution.target)),
        );
        continue;
      case 'export':
        resolved.set(spec, await stageFile(ctx, join(ctx.modulesPath, resolution.module, resolution.target)));
        continue;
    }
  }

  let out = source;
  for (const pattern of SPECIFIER_PATTERNS) {
    out = out.replace(pattern, (whole, ...groups) => {
      const spec = groups[groups.length - 3] as string;
      const target = resolved.get(spec);
      if (target === undefined || target === spec) return whole;
      return whole.replace(`${spec}`, target);
    });
  }

  return out;
};

/** A staged `#!ts` command: the URL to import, and the registry or network specifiers its graph imports. */
type StagedTsCommand = { url: string; packages: string[] };

/**
 * Stage a `#!ts` command and everything it imports.
 *
 * `commandPath` is the VFS path the shell resolved, and is what identifies the owning module; a
 * file with no manifest above it has its bare specifiers left to the process's import map. This
 * stages whatever it is given: whether a file may run in this process at all is the caller's to
 * decide (ein/core#549).
 */
export const stageTsCommand = async (
  vfs: NodeVFS,
  access: Access,
  commandPath: string,
  source: string,
  modulesPath: string,
): Promise<StagedTsCommand> => {
  const ctx: StageContext = {
    vfs,
    access,
    modulesPath: modulesPath.replace(/\/$/, ''),
    manifests: new Map(),
    staged: new Map(),
    stack: [],
    sources: new Map([[commandPath, source]]),
    packages: new Set(),
  };

  const url = await stageFile(ctx, commandPath);
  return { url, packages: [...ctx.packages] };
};

/** One entry per bin per process: the imported command and the bin node fingerprint it was built from. */
type LoadedCommand = { key: string; fn: CmdFunction };

const loaded = new Map<string, LoadedCommand>();

const cacheKeyOf = (modulesPath: string, commandPath: string): string => `${modulesPath} ${commandPath}`;

/**
 * What has to change before the staging is worth redoing.
 *
 * mtime and size, i.e. what a `make` would use. Both come off the `get` the shell already did to
 * check execute access, so testing them costs nothing — which is the point: a hit must not pay a
 * VFS round trip, or it has bought very little.
 *
 * Exact either way: a module on a filesystem mount takes both fields from a real `stat`, and one
 * installed into the VFS gets `modtime` bumped on every write that carried bytes, a same-length
 * overwrite included. `mod setup` and `mod remove` clear the cache outright as well, since an
 * upgrade replaces a bin wholesale.
 */
const fingerprintOf = (node: Node<FileAttrs>): string => `${node.props.modtime.timestamp}:${node.attrs.size ?? -1}`;

/**
 * The already-loaded command for this bin, if the bin has not changed since.
 *
 * Called before the bin is read, so a hit skips the read, `mod.json`, hashing and rewriting the
 * whole local graph, and the `import()`.
 */
export const cachedTsCommand = (
  modulesPath: string,
  commandPath: string,
  node: Node<FileAttrs>,
): CmdFunction | undefined => {
  const entry = loaded.get(cacheKeyOf(modulesPath, commandPath));
  return entry && entry.key === fingerprintOf(node) ? entry.fn : undefined;
};

/** Forget every loaded command. For tests, and for anything that replaces a module wholesale. */
export const clearTsCommandCache = (): void => {
  loaded.clear();
};

/**
 * Stage a `#!ts` command, import it, and remember it for next time.
 *
 * Throws if the module does not default-export a `CmdFunction`, and caches nothing in that case —
 * a bin that fails to load must keep failing rather than be papered over by a later good load.
 */
export const loadTsCommand = async (
  vfs: NodeVFS,
  access: Access,
  commandPath: string,
  source: string,
  modulesPath: string,
  node: Node<FileAttrs>,
): Promise<CmdFunction> => {
  const { url } = await stageTsCommand(vfs, access, commandPath, source, modulesPath);
  const mod = await import(url);
  const fn = mod.default as CmdFunction;

  if (!fn || typeof fn !== 'function' || !fn.spec) {
    throw new Error(`${commandPath}: invalid typescript command (must default-export a CmdFunction)`);
  }

  loaded.set(cacheKeyOf(modulesPath, commandPath), { key: fingerprintOf(node), fn });

  return fn;
};
