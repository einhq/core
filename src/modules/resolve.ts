/**
 * How a bare specifier in a module's source resolves — the one rule every consumer shares.
 *
 * A module's manifest has three maps, each with one job:
 *
 *   - `exports`: the module's public interface, `./<name>` -> a file in the module. Other
 *     modules import it as `@<module>/<name>`; nothing else in the module is reachable from
 *     outside.
 *   - `imports`: what the module itself uses — private aliases into its own files and external
 *     packages (`jsr:`, `npm:`). Never a path into another module.
 *   - `dependencies`: the other modules it needs. Importing `@<dep>/<name>` is allowed only when
 *     `<dep>` is listed here, and resolves through that module's own `exports`.
 *
 * So a specifier is looked up in the module's own `imports` (longest prefix, the way an import
 * map resolves), then its own `exports`, then a declared dependency's `exports`. Anything else
 * is left to core's base map (`@ein/client`, `@ein/testing`, `@ein/paths`).
 *
 * The loader (`ts-command-loader.ts`), `deno task sync:modules` (which projects this into each
 * module's `deno.jsonc` for type-checking and the UI bundler) and the boundary test all resolve
 * through here, so the three cannot disagree about what a module may import.
 *
 * Deliberately pure: no VFS, no filesystem. Callers read the manifests however they are stored.
 */

import type { ModuleManifest } from './types.ts';

export type SpecifierResolution =
  /** From the owner's own `imports`. `target` is the mapped value: a package URL or a path relative to the owner's root. */
  | { kind: 'import'; target: string }
  /** A file some module exports. `target` is relative to *that* module's root. */
  | { kind: 'export'; module: string; target: string }
  /** Not a module specifier: core's base map owns it. */
  | { kind: 'core' }
  /** Looks like a module's export but may not be imported from here. */
  | { kind: 'error'; message: string };

/**
 * Longest-prefix lookup, the way an import map resolves; keeps the remainder after the key. As in
 * Deno, a key reaches below itself only when it ends in `/` or names a `jsr:`/`npm:` package
 * (`@std/path` → `@std/path/posix`): `@archive/timeline` mapping to a file says nothing about
 * `@archive/timeline/api`.
 */
export const mapSpecifier = (spec: string, imports: Record<string, string>): string | undefined => {
  let best: string | undefined;
  for (const key of Object.keys(imports)) {
    const below = key.endsWith('/') ? spec.startsWith(key) : /^(jsr|npm):/.test(imports[key]) && spec.startsWith(`${key}/`);
    if (spec !== key && !below) continue;
    if (best === undefined || key.length > best.length) best = key;
  }
  if (best === undefined) return undefined;

  return imports[best] + spec.slice(best.length);
};

/** `@archive/people/genealogy` -> `{ module: 'archive', path: './people/genealogy' }`; undefined for anything else. */
const splitModuleSpecifier = (spec: string): { module: string; path: string } | undefined => {
  const match = spec.match(/^@([a-z0-9][a-z0-9-]*)\/(.+)$/);
  return match ? { module: match[1], path: `./${match[2]}` } : undefined;
};

/**
 * Resolve one bare specifier used by `owner`'s source.
 *
 * `lookup` returns an installed module's manifest by name, or undefined. It is only consulted for
 * a specifier shaped like `@<module>/…`, so a caller that knows only the owner and its
 * dependencies still gets a correct answer for everything the owner is allowed to import.
 */
export const resolveModuleSpecifier = (
  spec: string,
  owner: ModuleManifest,
  lookup: (name: string) => ModuleManifest | undefined,
): SpecifierResolution => {
  const mapped = mapSpecifier(spec, owner.imports ?? {});
  if (mapped !== undefined) return { kind: 'import', target: mapped };

  const parts = splitModuleSpecifier(spec);
  if (!parts) return { kind: 'core' };

  if (parts.module === owner.name) {
    const target = owner.exports?.[parts.path];
    if (target !== undefined) return { kind: 'export', module: owner.name, target };
    return { kind: 'error', message: `${owner.name}: '${spec}' is neither in its imports nor its exports` };
  }

  const declared = Object.hasOwn(owner.dependencies ?? {}, parts.module);
  const provider = lookup(parts.module);

  if (!declared) {
    // A scope that names no module at all is some package the owner forgot to declare; core's
    // base map gets the last word, exactly as for any other unknown bare specifier.
    if (!provider) return { kind: 'core' };
    return { kind: 'error', message: `${owner.name}: imports '${spec}' but does not list '${parts.module}' in its dependencies` };
  }
  if (!provider) {
    return { kind: 'error', message: `${owner.name}: imports '${spec}' but module '${parts.module}' is not installed` };
  }

  const target = provider.exports?.[parts.path];
  if (target === undefined) {
    const offered = Object.keys(provider.exports ?? {}).map((key) => `@${parts.module}/${key.slice(2)}`);
    return {
      kind: 'error',
      message: `${owner.name}: '${spec}' is not exported by '${parts.module}'${offered.length ? ` (exports: ${offered.join(', ')})` : ' (it exports nothing)'}`,
    };
  }

  return { kind: 'export', module: parts.module, target };
};

/**
 * The import map a module's files resolve against, with every target relative to that module's
 * root: its own `imports`, its own `exports` under `@<name>/…`, and each dependency's `exports`
 * under `@<dep>/…` at `../<dep>/…`.
 *
 * The sibling layout (`../<dep>`) is where modules sit today, both in the repository and under
 * `/modules`; this is the one place that assumes it. An own `imports` key wins over a generated
 * one, the same precedence `resolveModuleSpecifier` applies.
 */
export const moduleImportMap = (
  owner: ModuleManifest,
  lookup: (name: string) => ModuleManifest | undefined,
): Record<string, string> => {
  const map: Record<string, string> = {};

  for (const dep of Object.keys(owner.dependencies ?? {}).sort()) {
    for (const [key, target] of Object.entries(lookup(dep)?.exports ?? {})) {
      map[`@${dep}/${key.slice(2)}`] = `../${dep}/${target.replace(/^\.\//, '')}`;
    }
  }
  for (const [key, target] of Object.entries(owner.exports ?? {})) {
    map[`@${owner.name}/${key.slice(2)}`] = target;
  }
  Object.assign(map, owner.imports ?? {});

  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
};

/** True when a manifest path stays inside the module: `./…`, no `..` segment. */
const isModuleLocalPath = (target: string): boolean => target.startsWith('./') && !target.split('/').includes('..');

/** True for a target Deno resolves without an import map. */
export const isPackageTarget = (target: string): boolean => /^(jsr|npm|node|https?|data):/.test(target);

/**
 * Structural problems with `exports` and `imports`, independent of what is installed.
 *
 * An `imports` target is a package or a path inside the module — reaching into another module is
 * what `dependencies` and that module's `exports` are for. An `exports` key is `./<name>` — or
 * `./<area>/<name>` in a module made of several areas, as archive is — and its target a file
 * inside the module.
 */
export const checkModuleMaps = (manifest: ModuleManifest): string[] => {
  const errors: string[] = [];
  const name = manifest.name;

  for (const [field, map] of [['imports', manifest.imports], ['exports', manifest.exports]] as const) {
    if (map === undefined) continue;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      errors.push(`${name}: ${field} must be an object`);
      continue;
    }
    for (const [key, target] of Object.entries(map)) {
      if (typeof target !== 'string') {
        errors.push(`${name}: ${field} '${key}' must map to a string`);
        continue;
      }
      if (field === 'exports') {
        if (!/^\.\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(key)) {
          errors.push(`${name}: export '${key}' must be './<name>' or './<area>/<name>' (lowercase, dashes)`);
        }
        if (!isModuleLocalPath(target)) errors.push(`${name}: export '${key}' must point inside the module: ${target}`);
      } else if (!isPackageTarget(target) && !isModuleLocalPath(target)) {
        errors.push(`${name}: import '${key}' must be a package or a path inside the module, not ${target}`);
      }
    }
  }

  return errors;
};
