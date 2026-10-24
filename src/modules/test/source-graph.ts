/**
 * The repository's source graph, as the reachability suite sees it: which files the entry points
 * reach, and which of their exports another reached file uses.
 *
 * Specifiers resolve the way they do at runtime: inside a module through its manifest
 * (`src/modules/resolve.ts`), then through core's `deno.jsonc`. Parsing is by pattern, not by a
 * TypeScript parser: it knows the export and import forms this repository writes, and a form it
 * does not know shows up as a false "unused", never as a hidden one.
 */

import { walk } from '@std/fs/walk';
import { parse as parseJsonc } from '@std/jsonc';
import { dirname, join, relative, resolve } from '@std/path';
import { isPackageTarget, mapSpecifier, resolveModuleSpecifier } from '../resolve.ts';
import type { ModuleManifest } from '../types.ts';
import { moduleSourceDir, REPO_ROOT, repoModules, UI_SOURCE_DIR } from '../repo.ts';
import { lentTypePaths } from '../../builtin/ui/lib/shared.ts';

/** Directories that are never entry points and whose files are not checked. */
const NOT_SOURCE = /(^|\/)(test|tests|fixtures|scripts|eval|node_modules|\.build)\//;

/** A checked source: `.ts`/`.tsx` outside tests, scripts, evals and the test harness. */
export const isChecked = (path: string): boolean => {
  const rel = relative(REPO_ROOT, path);
  return /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !NOT_SOURCE.test(rel) && !rel.startsWith('src/testing/');
};

/**
 * Source with comments blanked. Strings, template literals and regular expressions are skipped
 * whole, so a `//` or `/*` inside one is not taken for a comment; a `/` starts a regular
 * expression where an operand is expected, which is the rule the language itself uses.
 */
const withoutComments = (source: string): string => {
  let out = '';
  let i = 0;
  let last = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    const regex = ch === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd()));
    if (ch === '"' || ch === "'" || ch === '`' || regex) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (regex && c === '[') inClass = true;
        else if (regex && c === ']') inClass = false;
        else if (c === ch && !inClass) break;
        else if (c === '\n' && ch !== '`') break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = ch;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return out;
};

/** What one file imports from another: the names, or every export (`*`) for a namespace or dynamic import. */
type Use = { spec: string; names: string[] | '*' };

/** What a file exports: its own declarations, and what it re-exports from elsewhere. */
type Exports = {
  own: Set<string>;
  /** `export { a as b } from 'x'`: b -> { spec, name: a }. */
  named: Map<string, { spec: string; name: string }>;
  /** `export * from 'x'`. */
  star: string[];
};

/** `a, type b, c as d` -> [[a, a], [b, b], [c, d]], as [imported, local] pairs. */
const bindings = (list: string): [string, string][] =>
  list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [from, as] = part.split(/\s+as\s+/);
      return [from.trim(), (as ?? from).trim()];
    });

/** Every specifier a source imports, with the names it takes. */
export const usesIn = (raw: string): Use[] => {
  const source = withoutComments(raw);
  const uses: Use[] = [];
  const add = (spec: string, names: string[] | '*') => {
    if (!spec.includes('${') && !/\s/.test(spec)) uses.push({ spec, names });
  };

  // import X, { a, b as c } from 'x' | import * as ns from 'x' | import type { … } from 'x'
  for (const m of source.matchAll(/\bimport\s+(?:type\s+)?([\w$]+\s*,\s*)?(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s+(['"])([^'"]+)\3/g)) {
    const [, defaultPart, clause, , spec] = m;
    const names: string[] = [];
    if (defaultPart) names.push('default');
    if (!clause) {
      add(spec, names);
    } else if (clause.startsWith('*')) {
      add(spec, '*');
    } else if (clause.startsWith('{')) {
      add(spec, [...names, ...bindings(clause.slice(1, -1)).map(([name]) => name)]);
    } else {
      add(spec, [...names, 'default']);
    }
  }
  // export { a as b } from 'x' | export * from 'x' | export * as ns from 'x'
  for (const m of source.matchAll(/\bexport\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s+(['"])([^'"]+)\2/g)) {
    const [, clause, , spec] = m;
    // A plain `export *` uses nothing by itself: what the re-exporter's importers ask for passes through.
    if (clause === '*') add(spec, []);
    else if (clause.startsWith('*')) add(spec, '*');
    else add(spec, bindings(clause.slice(1, -1)).map(([name]) => name));
  }
  // import('x') and side-effect imports
  for (const m of source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)) add(m[2], '*');
  for (const m of source.matchAll(/(?:^|[\s;])import\s+(['"])([^'"]+)\1/gm)) add(m[2], []);
  for (const m of source.matchAll(/new\s+URL\(\s*(['"])([^'"\s]+)\1\s*,\s*import\.meta\.url/g)) add(m[2], '*');

  return uses;
};

/** What a source exports. */
export const exportsIn = (raw: string): Exports => {
  const source = withoutComments(raw);
  const own = new Set<string>();
  const named = new Map<string, { spec: string; name: string }>();
  const star: string[] = [];

  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([\w$]+)/gm)) own.add(m[1]);
  if (/^export\s+default\b/m.test(source)) own.add('default');
  for (const m of source.matchAll(/^export\s+(?:const|let)\s+\{([^}]*)\}\s*=/gm)) {
    for (const [, local] of bindings(m[1].replace(/:\s*[\w$]+/g, (s) => ` as ${s.slice(1).trim()}`))) own.add(local);
  }
  for (const m of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(\s*from\s+(['"])([^'"]+)\3)?/g)) {
    for (const [name, as] of bindings(m[1])) {
      if (m[4]) named.set(as, { spec: m[4], name });
      else own.add(as);
    }
  }
  for (const m of source.matchAll(/\bexport\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2/g)) own.add(m[1]);
  for (const m of source.matchAll(/\bexport\s+\*\s+from\s+(['"])([^'"]+)\1/g)) star.push(m[2]);

  return { own, named, star };
};

const readJsonc = async <T>(path: string): Promise<T> => parseJsonc(await Deno.readTextFile(path)) as T;

const filesUnder = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  try {
    for await (const entry of walk(dir, { includeDirs: false })) out.push(entry.path);
  } catch {
    // absent
  }
  return out;
};

export type SourceGraph = {
  /** Every `.ts`/`.tsx` the suite checks, absolute. */
  sources: string[];
  /** Every file an entry point reaches, absolute. */
  reached: Set<string>;
  /** The entry points, absolute: every export of one counts as used. */
  entries: Set<string>;
  /** Every source read: the reached files, the tests, the scripts and the test harness. */
  text: Map<string, string>;
  /** The file a specifier written in `from` names, or undefined for a package. */
  resolveFrom: (spec: string, from: string) => string | undefined;
};

/**
 * Walk the import graph out from the entry points: `src/*-main.ts`, the shell's client, every
 * file in a module's `bin/`, `services/` and `etc/`, a manifest's `exports` and `ui.routes`, and
 * the files `deno.jsonc` tasks name.
 */
export const sourceGraph = async (): Promise<SourceGraph> => {
  const core = await readJsonc<{ imports: Record<string, string>; tasks: Record<string, string> }>(join(REPO_ROOT, 'deno.jsonc'));

  const manifests = new Map<string, { manifest: ModuleManifest; dir: string }>();
  for (const { name, dir } of repoModules()) {
    try {
      manifests.set(name, { manifest: JSON.parse(await Deno.readTextFile(join(dir, 'mod.json'))), dir });
    } catch {
      // not a module
    }
  }
  const lookup = (name: string) => manifests.get(name)?.manifest;
  const owner = (path: string) => [...manifests.values()].find(({ dir }) => path.startsWith(`${dir}/`));
  // What the shell lends a module's pages as `@ein/ui/*`, resolved the way the page bundle does.
  const lent = lentTypePaths({}, join(UI_SOURCE_DIR, 'src', 'client'));

  const resolveFrom = (spec: string, from: string): string | undefined => {
    if (spec.startsWith('.') || spec.startsWith('/')) return resolve(dirname(from), spec);
    if (Object.hasOwn(lent, spec)) return lent[spec];
    const module = owner(from);
    if (module) {
      const resolution = resolveModuleSpecifier(spec, module.manifest, lookup);
      if (resolution.kind === 'import') return isPackageTarget(resolution.target) ? undefined : resolve(module.dir, resolution.target);
      if (resolution.kind === 'export') return resolve(moduleSourceDir(resolution.module), resolution.target);
    }
    const mapped = mapSpecifier(spec, core.imports);
    return mapped === undefined || isPackageTarget(mapped) ? undefined : resolve(REPO_ROOT, mapped);
  };

  const entries = new Set<string>();
  for await (const entry of Deno.readDir(join(REPO_ROOT, 'src'))) {
    if (entry.isFile && entry.name.endsWith('-main.ts')) entries.add(join(REPO_ROOT, 'src', entry.name));
  }
  entries.add(join(UI_SOURCE_DIR, 'src', 'client', 'main.tsx'));
  for (const { manifest, dir } of manifests.values()) {
    for (const sub of ['bin', 'services', 'etc']) for (const path of await filesUnder(join(dir, sub))) entries.add(path);
    for (const target of Object.values(manifest.ui?.routes ?? {})) entries.add(resolve(dir, target));
  }
  for (const task of Object.values(core.tasks)) {
    for (const word of task.split(/\s+/)) {
      if (/\.tsx?$/.test(word)) entries.add(resolve(REPO_ROOT, word));
    }
  }
  // A manifest's exports are reached, but are not entry points: only what another module imports of them is used.
  const queue = [...entries];
  for (const { manifest, dir } of manifests.values()) for (const target of Object.values(manifest.exports ?? {})) queue.push(resolve(dir, target));

  const reached = new Set<string>();
  const text = new Map<string, string>();
  while (queue.length) {
    const path = queue.pop()!;
    if (reached.has(path)) continue;
    reached.add(path);
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    if (source.includes('\0')) continue;
    text.set(path, source);
    for (const { spec } of usesIn(source)) {
      const target = resolveFrom(spec, path);
      if (target && !reached.has(target)) queue.push(target);
    }
  }

  const all = [...await filesUnder(join(REPO_ROOT, 'src')), ...await filesUnder(join(REPO_ROOT, 'modules')), ...await filesUnder(join(REPO_ROOT, 'scripts'))]
    .filter((path) => /\.tsx?$/.test(path) && !path.includes('/node_modules/') && !path.includes('/.build/'));
  for (const path of all) if (!text.has(path)) text.set(path, await Deno.readTextFile(path));

  const sources = all.filter((path) => isChecked(path) && relative(join(REPO_ROOT, 'modules'), path).includes('/'));

  return { sources, reached, entries, text, resolveFrom };
};

/**
 * Whether `body` names `name` anywhere but in its own top-level declaration, so a function that
 * only calls itself is not a use. The declaration runs to the next line that starts a statement
 * at the left margin; a closing bracket there still belongs to it.
 */
const usedOutsideDeclaration = (body: string, name: string): boolean => {
  const escaped = name.replace(/\$/g, '\\$');
  const decl = new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:const|let|var|function\\*?|class|type|interface|enum)\\s+${escaped}(?![\\w$])`, 'm')
    .exec(body);
  let outside = body;
  if (decl) {
    const next = /\n(?=[A-Za-z@])/g;
    next.lastIndex = decl.index + decl[0].length;
    const end = next.exec(body)?.index ?? body.length;
    outside = body.slice(0, decl.index) + body.slice(end);
  }
  return new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`).test(outside);
};

/** An export nothing else uses, and what to do about it. */
export type UnusedExport = { path: string; name: string; fix: 'unexport' | 'delete' };

/**
 * The exports of reached files that no other reached file uses, as `path: name`.
 *
 * An entry point's exports all count as used: a loader takes a bin's `default` and a page's
 * `default`, `handle` and `loader`. So do those of `contract`, the files whose exports are a
 * published interface rather than what this repository happens to use. A name asked of a file
 * that only re-exports it (`export *`, `export { a } from`) is followed to the file declaring it.
 *
 * A script under `scripts/` is a use: one is kept to be run by hand, and what it imports has to
 * be there when it is. A test is not, except of a name its own file uses too: exporting something
 * so that a test can reach it is fine, keeping something alive only for its test is not. What
 * remains is `unexport` when the file itself uses the name, and `delete` when nothing does.
 */
export const unusedExports = (graph: SourceGraph, contract: Set<string>): UnusedExport[] => {
  const exports = new Map<string, Exports>();
  for (const [path, source] of graph.text) exports.set(path, exportsIn(source));

  /** Marks, per file, the names something uses; `*` is every name. */
  const collect = (from: (path: string) => boolean, seeds: Iterable<string>) => {
    const used = new Map<string, Set<string>>();
    const all = new Set<string>();
    const mark = (path: string, name: string, seen = new Set<string>()) => {
      const key = `${path}\0${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ex = exports.get(path);
      if (!ex) return;
      const follow = (spec: string, as: string) => {
        const target = graph.resolveFrom(spec, path);
        if (target) mark(target, as, seen);
      };
      if (name === '*') {
        all.add(path);
        for (const { spec, name: from } of ex.named.values()) follow(spec, from);
        for (const spec of ex.star) follow(spec, '*');
        return;
      }
      if (ex.own.has(name)) {
        if (!used.has(path)) used.set(path, new Set());
        used.get(path)!.add(name);
        return;
      }
      const via = ex.named.get(name);
      if (via) return follow(via.spec, via.name);
      if (name !== 'default') { for (const spec of ex.star) follow(spec, name); }
    };
    for (const path of seeds) mark(path, '*');
    for (const [path, source] of graph.text) {
      if (!from(path)) continue;
      for (const { spec, names } of usesIn(source)) {
        const target = graph.resolveFrom(spec, path);
        if (!target) continue;
        for (const name of names === '*' ? ['*'] : names) mark(target, name);
      }
    }
    return (path: string, name: string) => all.has(path) || !!used.get(path)?.has(name);
  };

  const isScript = (path: string) => /(^|\/)scripts\//.test(relative(REPO_ROOT, path));
  const isUsed = collect((path) => graph.reached.has(path) || isScript(path), [...graph.entries, ...contract].filter((path) => graph.reached.has(path)));
  const isTested = collect((path) => !graph.reached.has(path) && !isScript(path), []);

  const out: UnusedExport[] = [];
  for (const path of graph.reached) {
    if (!isChecked(path) || graph.entries.has(path)) continue;
    const body = withoutComments(graph.text.get(path)!).replaceAll('...', '   ');
    for (const name of exports.get(path)?.own ?? []) {
      if (isUsed(path, name)) continue;
      const local = name !== 'default' && usedOutsideDeclaration(body, name);
      if (local && isTested(path, name)) continue;
      out.push({ path: relative(REPO_ROOT, path), name, fix: local ? 'unexport' : 'delete' });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
};
