/**
 * Module boundary suite — asserts that module code depends on the published contract only.
 *
 * Modules are meant to be distributable from their own repositories. Nothing enforces that at
 * runtime (they are mounted from the repo checkout), so the boundary is only real if it
 * is tested: the moment a module reaches for `@ein/exec` or `../../../src/...`, moving it out
 * of this repo stops working and nobody notices until someone tries.
 */

import { assertEquals } from '@std/assert';
import { exists } from '@std/fs/exists';
import { walk } from '@std/fs/walk';
import { parse as parseJsonc } from '@std/jsonc';
import { dirname, join, relative, resolve } from '@std/path';
import { resolveSetupOrder } from '../order.ts';
import { checkModuleMaps, mapSpecifier, moduleImportMap, resolveModuleSpecifier } from '../resolve.ts';
import type { ModuleManifest } from '../types.ts';
import { LIB_SOURCE_DIR, MODULES_DIR, moduleSourceDir, REPO_ROOT, repoModules, UI_SOURCE_DIR } from '../repo.ts';
import { lentTypePaths, sharedSpecifiers } from '../../builtin/ui/lib/shared.ts';

/**
 * Specifiers core supplies to every module, so a manifest need not restate them.
 *
 * Deliberately short: this is the base map `ts-command-loader.ts` leaves alone, and anything
 * added here is something every module gets whether it asked or not. `@ein/paths` is the VFS
 * root layout — a leaf with no imports of its own, which is why it is safe here where
 * `@ein/exec` is not.
 */
const CORE_PROVIDED = new Set(['@ein/client', '@ein/testing', '@ein/paths', '@ein/api']);

/**
 * What a module's pages may import of the browser shell's: the lent specifiers, nothing else of
 * it. A module carries its pages under `ui/` (`ui.routes`), bundled by `ui-build` against what the
 * shell lends at runtime (src/builtin/ui/lib/shared.ts) (ein/core#427).
 */
const LENT = new Set(Object.keys(sharedSpecifiers()));

/** A file under a module's `ui/`. */
const isModulePage = (path: string): boolean => relative(join(MODULES_DIR, moduleOf(path)), path).startsWith('ui/');

/** The first word of every simple command in a shell fragment, skipping leading `VAR=value`s. */
const commandWords = (script: string): string[] =>
  script
    .split(/[|;&\n]+|\$\(|`/)
    .map((segment) => segment.trim().replace(/^(\w+=\S+\s+)*/, '').split(/\s+/)[0])
    .filter(Boolean);

/**
 * Source with `//` and block comments blanked, so a command named in prose is not a call.
 *
 * Deliberately rough — it does not know about strings, so a `//` inside one ends that line early.
 * That only ever hides a string, never invents one, which is the safe direction for a check that
 * asserts edges it can see.
 */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every module manifest, by directory name. */
const readManifests = async (): Promise<Map<string, ModuleManifest>> => {
  const manifests = new Map<string, ModuleManifest>();
  for (const { name, dir } of repoModules()) {
    try {
      manifests.set(name, JSON.parse(await Deno.readTextFile(join(dir, 'mod.json'))));
    } catch {
      // not a module
    }
  }
  return manifests;
};

/** The module a path under `modules/` belongs to. */
const moduleOf = (path: string): string => relative(MODULES_DIR, path).split('/')[0];

/** Every specifier a source imports: `from '…'`, a side-effect `import '…'`, and `import('…')`. */
const specifiersIn = (source: string): string[] => {
  const out = new Set<string>();
  for (const pattern of [/\bfrom\s+(['"])([^'"]+)\1/g, /\bimport\s*\(\s*(['"])([^'"]+)\1/g, /(?:^|[\s;])import\s+(['"])([^'"]+)\1/gm]) {
    for (const match of source.matchAll(pattern)) {
      // `from '${...}'` inside a template literal is codegen, not an import (the UI bundler
      // writes import statements into generated route files), and a quoted phrase with a space
      // in it is prose in a comment or a message that happens to follow the word "from".
      const spec = match[2];
      if (spec.includes('${') || /\s/.test(spec) || /^\d+$/.test(spec)) continue;
      out.add(spec);
    }
  }
  return [...out];
};

/** Source files a module ships, including extensionless `#!ts` bins. */
const moduleSources = async (): Promise<string[]> => {
  const out: string[] = [];
  if (!await exists(MODULES_DIR)) return out;
  for await (const entry of walk(MODULES_DIR, { includeDirs: false })) {
    if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(entry.path);
      continue;
    }
    // Extensionless bins: only those carrying the TypeScript shebang.
    if (!entry.path.includes('/bin/')) continue;
    if (/\.[a-z]+$/.test(entry.name)) continue;
    try {
      const head = (await Deno.readTextFile(entry.path)).slice(0, 8);
      if (head.startsWith('#!ts')) out.push(entry.path);
    } catch {
      // Unreadable or binary — not a source file.
    }
  }
  return out;
};

Deno.test('modules do not import core internals', async (t) => {
  const files = await moduleSources();

  await t.step('every module in the checkout has sources to check', () => {
    // A glob that silently matches nothing would make every assertion below vacuous. A checkout
    // with no modules has nothing to check.
    const withSources = new Set(files.map(moduleOf));
    assertEquals(repoModules().map(({ name }) => name).filter((name) => !withSources.has(name)), []);
  });

  await t.step('no module imports @ein/exec', () => {
    const offenders = files
      .filter((path) => Deno.readTextFileSync(path).includes('@ein/exec'))
      .map((path) => relative(REPO_ROOT, path));

    assertEquals(
      offenders,
      [],
      `modules must import @ein/client, not core's internal @ein/exec:\n  ${offenders.join('\n  ')}`,
    );
  });

  await t.step('no module reaches into src/ by relative path, tests included', () => {
    // Tests too: a module in another repository has no `../../../src` to reach for.
    // Resolved, not matched: a module may have a `src/` of its own, a `../src/` away from its `lib/`.
    const offenders = files
      .filter((path) =>
        [...Deno.readTextFileSync(path).matchAll(/from\s+'((?:\.\.\/)+src\/[^']*)'/g)]
          .some((match) => !resolve(dirname(path), match[1]).startsWith(`${join(MODULES_DIR, moduleOf(path))}/`))
      )
      .map((path) => relative(REPO_ROOT, path));

    assertEquals(
      offenders,
      [],
      `modules must not import core by relative path:\n  ${offenders.join('\n  ')}`,
    );
  });

  await t.step("no module command parses args without core's wrapper", () => {
    // `@ein/client` re-exports core's `parseArgs`, which splits a value attached to a short
    // option off into its own argument (`-d:` -> `-d` `:`). `@std/cli` only does that when the
    // value is a number, so `cut -d" " -f2` would split on the empty string. Going
    // through the client also means the module needs no `@std/cli` line in its manifest.
    //
    // A module's `scripts/` is exempt: those are host-side `deno run` scripts with no
    // EiN runtime and no command object, so the client contract does not apply to them.
    const offenders = files
      .filter((path) => !path.includes('/scripts/'))
      .filter((path) => Deno.readTextFileSync(path).includes("from '@std/cli"))
      .map((path) => relative(REPO_ROOT, path));

    assertEquals(
      offenders,
      [],
      `take parseArgs from @ein/client, not @std/cli:\n  ${offenders.join('\n  ')}`,
    );
  });

  await t.step('no module reads JSON_OUTPUT out of the environment', () => {
    // `cmd.json` is the same signal plus the `json: false` spec opt-out, which is how a command
    // declares it emits text however the shell was started. Reading the env var directly
    // bypasses that opt-out, and bypasses it silently:
    // the two agree until the day a command declares `json: false`, at which point it keeps
    // emitting JSON at a caller that asked for text.
    const offenders = files
      .filter((path) => Deno.readTextFileSync(path).includes('env.JSON_OUTPUT'))
      .map((path) => relative(REPO_ROOT, path));

    assertEquals(
      offenders,
      [],
      `check cmd.json, not the env var:\n  ${offenders.join('\n  ')}`,
    );
  });

  const manifests = await readManifests();
  const lookup = (name: string) => manifests.get(name);

  await t.step('every manifest keeps its imports and exports inside the module', async () => {
    // A path into another module is what `dependencies` and that module's `exports` replace;
    // `mod setup` refuses the same thing (src/modules/validate.ts).
    const offenders: string[] = [];
    for (const [name, manifest] of manifests) {
      if (manifest.name !== name) offenders.push(`${name}: mod.json names it '${manifest.name}'`);
      offenders.push(...checkModuleMaps(manifest));
      for (const [key, target] of Object.entries(manifest.exports ?? {})) {
        try {
          await Deno.stat(join(MODULES_DIR, name, target));
        } catch {
          offenders.push(`${name}: export '${key}' points at a missing file: ${target}`);
        }
      }
    }
    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step('every specifier a module uses resolves by the module rule', async () => {
    // The invariant that makes a module movable. The loader resolves a bin's imports against its
    // own manifest and its dependencies' exports (src/modules/resolve.ts), so a specifier that
    // resolves here only because core's deno.jsonc happens to carry it would break the moment
    // the module left this repo. Asserted here rather than by type-checking each module under a
    // generated import map, which drags core's whole npm graph in behind @ein/client.
    const offenders: string[] = [];

    for (const path of files) {
      const manifest = manifests.get(moduleOf(path));
      if (!manifest) continue;

      for (const spec of specifiersIn(await Deno.readTextFile(path))) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        if (isModulePage(path) && LENT.has(spec)) continue;
        const resolution = resolveModuleSpecifier(spec, manifest, lookup);
        if (resolution.kind === 'error') offenders.push(`${relative(REPO_ROOT, path)}: ${resolution.message}`);
        else if (resolution.kind === 'core' && !CORE_PROVIDED.has(spec)) {
          offenders.push(`${relative(REPO_ROOT, path)}: '${spec}' is not in ${manifest.name}/mod.json imports`);
        }
      }
    }

    assertEquals(offenders, [], `unresolvable specifiers:\n  ${offenders.join('\n  ')}`);
  });

  await t.step('no relative import leaves its module', async () => {
    // A `../other-module/...` path is a dependency the manifest cannot see, and one that stops
    // resolving the day the two modules are not siblings.
    const offenders: string[] = [];
    for (const path of files) {
      const root = join(MODULES_DIR, moduleOf(path));
      for (const spec of specifiersIn(await Deno.readTextFile(path))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(path), spec);
        if (relative(root, target).startsWith('..')) offenders.push(`${relative(REPO_ROOT, path)}: '${spec}' leaves ${moduleOf(path)}`);
      }
    }
    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step('every imports entry is used', async () => {
    // Slim, and honest: an entry nothing imports reads as a dependency the module does not have.
    const used = new Map<string, Set<string>>();
    for (const path of files) {
      const name = moduleOf(path);
      const imports = manifests.get(name)?.imports ?? {};
      if (!used.has(name)) used.set(name, new Set());
      for (const spec of specifiersIn(await Deno.readTextFile(path))) {
        // The key the specifier resolved through: the longest one that maps it.
        const key = Object.keys(imports)
          .filter((candidate) => spec === candidate || spec.startsWith(`${candidate}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (key && mapSpecifier(spec, imports) !== undefined) used.get(name)!.add(key);
      }
    }

    const offenders: string[] = [];
    for (const [name, manifest] of manifests) {
      for (const key of Object.keys(manifest.imports ?? {})) {
        if (!used.get(name)?.has(key)) offenders.push(`${name}: imports '${key}' but nothing uses it`);
      }
    }
    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step('module dependencies form no cycle', () => {
    // `mod setup --all` refuses a cycle, so one would be a boot that half-installs.
    assertEquals(resolveSetupOrder(manifests).cycles, []);
  });

  await t.step("a module runs another module's commands only when it declares that module", async () => {
    // Imports are only half of what a module needs from another: a bin that runs `assign-faces`
    // needs media installed as surely as one that imports `@media/face-crop`. Found by reading the
    // command words out of `execute(...)` strings, pipeline `command:` lines and shell scripts —
    // a heuristic, so it only asserts edges it can see, never that an edge is absent.
    const owners = new Map<string, string>();
    for (const name of manifests.keys()) {
      try {
        for await (const bin of Deno.readDir(join(moduleSourceDir(name), 'bin'))) owners.set(bin.name, name);
      } catch {
        // no bin/
      }
    }

    const edges = new Map<string, Set<string>>();
    const record = (from: string, words: string[], where: string) => {
      for (const word of words) {
        const to = owners.get(word);
        if (!to || to === from) continue;
        const key = `${from} -> ${to}`;
        if (!edges.has(key)) edges.set(key, new Set());
        edges.get(key)!.add(`${word} (${where})`);
      }
    };

    // Tests are left out, beside their source too: a test's strings are examples, not calls.
    if (!await exists(MODULES_DIR)) return;
    for await (const entry of walk(MODULES_DIR, { includeDirs: false, skip: [/\/(test|docs|fixtures)\//, /\.test\.tsx?$/] })) {
      const from = moduleOf(entry.path);
      const where = relative(join(MODULES_DIR, from), entry.path);
      let source: string;
      try {
        source = await Deno.readTextFile(entry.path);
      } catch {
        continue;
      }
      if (source.includes('\0') || entry.name.endsWith('.md')) continue;

      if (/\.ya?ml$/.test(entry.name)) {
        for (const match of source.matchAll(/^\s*(?:-\s*)?(?:command|run):\s*(.+)$/gm)) record(from, commandWords(match[1]), where);
      } else if (/\.(ts|tsx)$/.test(entry.name) || source.startsWith('#!ts')) {
        for (const match of source.matchAll(/\b(?:execute|executeInline|execCommand|exec)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
          record(from, commandWords(match[1].slice(1, -1)), where);
        }
        // Commands are also assembled in a variable and run later (`const cmd = `person-unknown …``),
        // which the call pattern cannot see. A string that starts with another module's command
        // name counts too — hyphenated names only, since `album`, `person` and `device` are also
        // node types and appear as plain words everywhere — unless it is a URL parameter's key
        // (`params.getAll('person-name')`), which a search page names after its flag.
        const command = /(?<!\.(?:get|getAll|append|set|has|delete)\(\s*)[`'"]([a-z][a-z0-9]*-[a-z0-9-]+)(?=[\s`'"$])/g;
        for (const match of withoutComments(source).matchAll(command)) record(from, [match[1]], where);
      } else if (entry.name.endsWith('.sh') || source.startsWith('#!')) {
        record(from, commandWords(source.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')), where);
      }
    }

    const offenders: string[] = [];
    for (const [edge, calls] of [...edges].sort()) {
      const [from, to] = edge.split(' -> ');
      const manifest = manifests.get(from)!;
      if (Object.hasOwn(manifest.dependencies ?? {}, to)) continue;
      offenders.push(`${edge}: ${[...calls].join(', ')} — add '${to}' to ${from}'s dependencies`);
    }

    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step("pages live under a module's ui/", async () => {
    // A module's pages reach the kit through the shell at runtime, and the module's commands stay
    // apart from its pages.
    const offenders: string[] = [];
    for (const [name, manifest] of manifests) {
      for (const page of Object.values(manifest.ui?.routes ?? {})) {
        if (!page.startsWith('ui/')) offenders.push(`${name}: ui.routes page ${page} is outside its ui/`);
      }
    }
    for (const path of files) {
      if (isModulePage(path)) continue;
      if (specifiersIn(await Deno.readTextFile(path)).some((spec) => spec === 'react' || spec.startsWith('react/') || spec.startsWith('@mantine/'))) {
        offenders.push(`${relative(REPO_ROOT, path)}: imports React or Mantine outside a ui/ directory`);
      }
    }
    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step("every module's deno.jsonc is the projection of its mod.json", async () => {
    // A module is a Deno workspace member, so `deno check`, `deno task check:bins`, this tier and
    // the UI bundler resolve its files against `modules/<name>/deno.jsonc` rather than against
    // core's map — which is only the module rule if the file is `moduleImportMap` of the
    // manifest. Drift is silent in the direction that matters least (an extra alias in the member
    // config resolves fine here and fails the moment the module is installed somewhere else), so
    // it is asserted rather than left to the next resolution error.
    const offenders: string[] = [];
    const coreImports = (parseJsonc(await Deno.readTextFile(join(REPO_ROOT, 'deno.jsonc'))) as { imports: Record<string, string> }).imports;

    for (const [name, manifest] of manifests) {
      const configPath = join(moduleSourceDir(name), 'deno.jsonc');
      let config: { imports?: Record<string, string> } = {};
      let present = true;
      try {
        config = parseJsonc(await Deno.readTextFile(configPath)) as { imports?: Record<string, string> };
      } catch {
        present = false;
      }

      // As scripts/sync-module-configs.ts writes it: a module with pages also gets the lent type paths.
      const wanted = {
        ...(manifest.ui?.routes ? lentTypePaths(coreImports, relative(moduleSourceDir(name), join(UI_SOURCE_DIR, 'src', 'client'))) : {}),
        ...moduleImportMap(manifest, lookup),
      };
      // A module with nothing to map needs no member config, and having one would be a file that
      // says nothing.
      if (Object.keys(wanted).length === 0 && !present) continue;

      const actual = present ? config.imports ?? {} : {};
      for (const key of new Set([...Object.keys(wanted), ...Object.keys(actual)])) {
        if (wanted[key] === actual[key]) continue;
        offenders.push(`${name}: '${key}' is ${JSON.stringify(actual[key])} in deno.jsonc, ${JSON.stringify(wanted[key])} by mod.json`);
      }
    }

    assertEquals(offenders, [], `module configs are stale, run \`deno task sync:modules\`:\n  ${offenders.join('\n  ')}`);
  });

  /**
   * A bin may be a thin entry point for a command that lives in its module's `lib/` (the archive
   * module's are): `import { search } from '@archive/search'; export default search;`. Then the
   * spec is where the command is, reached through the module's own `imports`.
   */
  const specInOwnLib = async (bin: string, source: string, name: string): Promise<boolean> => {
    const specifier = source.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`))?.[1];
    const moduleRoot = dirname(dirname(bin));
    const manifest = JSON.parse(await Deno.readTextFile(join(moduleRoot, 'mod.json'))) as ModuleManifest;
    const target = specifier ? manifest.imports?.[specifier] : undefined;
    if (!target) return false;
    const lib = await Deno.readTextFile(join(moduleRoot, target));
    return new RegExp(`\\b${name}\\.spec\\s*=`).test(lib);
  };

  await t.step('every #!ts bin default-exports a function carrying a spec', async () => {
    // The loader casts `mod.default` to CmdFunction, so a bin missing either is a runtime
    // "invalid typescript command" that no type-check catches.
    const offenders: string[] = [];
    for (const path of files) {
      if (!path.includes('/bin/')) continue;
      const source = await Deno.readTextFile(path);
      if (!source.startsWith('#!ts')) continue;
      const exported = source.match(/export default (\w+)/)?.[1];
      if (!exported) offenders.push(`${relative(REPO_ROOT, path)}: no default export`);
      else if (!/\.spec\s*=/.test(source) && !await specInOwnLib(path, source, exported)) offenders.push(`${relative(REPO_ROOT, path)}: no .spec`);
    }
    assertEquals(offenders, [], offenders.join('\n  '));
  });

  await t.step('every pooled step names a kind some worker in the module claims', async () => {
    // A `kind` no worker declares is not a slow step — the pool has nobody to claim it, so the
    // instance sits in `pending` forever with nothing logged.
    const offenders: string[] = [];

    for (const { name: moduleName, dir: moduleRoot } of repoModules()) {
      // What the module's workers accept, across all of its services.
      const claimed = new Set<string>();
      try {
        for await (const entry of walk(join(moduleRoot, 'services'), { includeDirs: false })) {
          const source = await Deno.readTextFile(entry.path);
          for (const m of source.matchAll(/--kind\s+([\w-]+)/g)) claimed.add(m[1]);
        }
      } catch {
        // no services/ — then no pooled step may be declared either
      }

      try {
        for await (const entry of walk(join(moduleRoot, 'pipelines'), { includeDirs: false })) {
          if (!/\.ya?ml$/.test(entry.name)) continue;
          const source = await Deno.readTextFile(entry.path);
          // Only steps delegated to a pool need a worker; inline steps run in the engine.
          if (!/^\s*pool:/m.test(source)) continue;
          for (const m of source.matchAll(/^\s*kind:\s*([\w-]+)/gm)) {
            if (claimed.has(m[1])) continue;
            offenders.push(`${relative(REPO_ROOT, entry.path)}: kind '${m[1]}' claimed by no worker in ${moduleName}`);
          }
        }
      } catch {
        // no pipelines/
      }
    }

    assertEquals(offenders, [], `unclaimable pooled steps:\n  ${offenders.join('\n  ')}`);
  });

  await t.step("every service, core's and the modules', restarts after failure", async () => {
    const offenders: string[] = [];

    for (const dir of [join(LIB_SOURCE_DIR, 'core'), ...repoModules().map((module) => module.dir)]) {
      const servicesDir = join(dir, 'services');

      try {
        for await (const serviceDir of Deno.readDir(servicesDir)) {
          if (!serviceDir.isDirectory) continue;
          const configPath = join(servicesDir, serviceDir.name, 'config.json');
          try {
            const config = JSON.parse(await Deno.readTextFile(configPath));
            if (config.restartPolicy !== 'on-failure') {
              offenders.push(`${relative(REPO_ROOT, configPath)}: restartPolicy is not on-failure`);
            }
          } catch {
            offenders.push(`${relative(REPO_ROOT, configPath)}: missing or invalid config`);
          }
        }
      } catch {
        // Module has no services.
      }
    }

    assertEquals(offenders, [], `services without crash recovery:\n  ${offenders.join('\n  ')}`);
  });

  await t.step('pipeline engine lets its inline steps finish before it stops', async () => {
    const configPath = join(LIB_SOURCE_DIR, 'core', 'services', 'pipeline-engine', 'config.json');
    const config = JSON.parse(await Deno.readTextFile(configPath));

    // A stopping engine waits for the inline steps it is running; they are the
    // short ones, the long work runs in pools. Fifteen minutes for them and a
    // minute for their final state writes and the engine's handle cleanup.
    assertEquals(config.stopTimeout, 16 * 60 * 1000);
  });
});
