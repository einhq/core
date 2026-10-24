/**
 * Manifest validation and setup ordering — the pure half of the module contract.
 *
 * Kept out of the booted contract suite because none of it needs a system: ordering and semver
 * checks are decisions about a set of manifests, and testing them directly means a failure
 * points at the rule rather than at whatever the install did next.
 */

import { assertEquals } from '@std/assert';
import { checkCoreApi, checkModuleMaps, checkUi, MODULE_API_VERSION, moduleImportMap, type ModuleManifest, resolveModuleSpecifier, resolveSetupOrder } from '../mod.ts';
import { repoModules } from '../repo.ts';

const mod = (name: string, extra: Partial<ModuleManifest> = {}): ModuleManifest => ({
  name,
  version: '0.1.0',
  ...extra,
});

Deno.test('setup order', async (t) => {
  const order = (manifests: ModuleManifest[]) => resolveSetupOrder(new Map(manifests.map((m) => [m.name, m])));

  await t.step('dependencies come before dependents', () => {
    // A dependent that sorts first: alphabetically `device` precedes `people`.
    const { order: got, cycles } = order([
      mod('device', { dependencies: { people: '^0.1.0' } }),
      mod('people'),
    ]);

    assertEquals(cycles, []);
    assertEquals(got.indexOf('people') < got.indexOf('device'), true, got.join(' '));
  });

  await t.step('transitive chains are fully ordered', () => {
    const { order: got } = order([
      mod('a', { dependencies: { b: '^0.1.0' } }),
      mod('b', { dependencies: { c: '^0.1.0' } }),
      mod('c'),
    ]);

    assertEquals(got, ['c', 'b', 'a']);
  });

  await t.step('a missing dependency does not stop the rest being ordered', () => {
    // Reporting it is validation's job; refusing to order would turn one bad manifest into a
    // dead boot for every other module.
    const { order: got, cycles } = order([mod('a', { dependencies: { ghost: '^1.0.0' } })]);

    assertEquals(cycles, []);
    assertEquals(got, ['a']);
  });

  await t.step('a cycle is reported and its members are left out', () => {
    const { order: got, cycles } = order([
      mod('a', { dependencies: { b: '^0.1.0' } }),
      mod('b', { dependencies: { a: '^0.1.0' } }),
      mod('loner'),
    ]);

    assertEquals(cycles.length, 1);
    assertEquals(got.includes('a'), false, got.join(' '));
    assertEquals(got.includes('b'), false, got.join(' '));
    assertEquals(got.includes('loner'), true, got.join(' '));
  });

  await t.step("the checkout's modules order without a cycle, each after its dependencies", async () => {
    const manifests = new Map<string, ModuleManifest>();
    for (const { name, dir } of repoModules()) {
      try {
        manifests.set(name, JSON.parse(await Deno.readTextFile(`${dir}/mod.json`)));
      } catch { /* not a module */ }
    }

    const { order: got, cycles } = resolveSetupOrder(manifests);
    assertEquals(cycles, []);
    assertEquals(got.length, manifests.size);
    for (const [name, manifest] of manifests) {
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (manifests.has(dependency)) assertEquals(got.indexOf(dependency) < got.indexOf(name), true, `${dependency} before ${name}: ${got.join(' ')}`);
      }
    }
  });
});

Deno.test('coreApi validation', async (t) => {
  await t.step('a satisfied range passes', () => {
    assertEquals(checkCoreApi(mod('m', { coreApi: `^${MODULE_API_VERSION}` })).errors, []);
  });

  await t.step('an unsatisfiable range is an error naming both versions', () => {
    const { errors } = checkCoreApi(mod('m', { coreApi: '^99.0.0' }));
    assertEquals(errors.length, 1);
    assertEquals(errors[0].includes('^99.0.0'), true, errors[0]);
    assertEquals(errors[0].includes(MODULE_API_VERSION), true, errors[0]);
  });

  await t.step('a malformed range is an error, not a crash', () => {
    assertEquals(checkCoreApi(mod('m', { coreApi: 'not-a-range' })).errors.length, 1);
  });

  await t.step('an absent coreApi warns but is accepted', () => {
    const { errors, warnings } = checkCoreApi(mod('m'));
    assertEquals(errors, []);
    assertEquals(warnings.length, 1);
  });
});

Deno.test('module UI validation', async (t) => {
  await t.step('routes mapping paths to pages in the module pass', () => {
    assertEquals(checkUi(mod('m', { ui: { routes: { '/things': 'ui/pages/things.tsx', '/things/:id': 'ui/pages/thing.tsx' } } })).errors, []);
  });

  await t.step('a page outside the module, or not a page, is rejected', () => {
    assertEquals(checkUi(mod('m', { ui: { routes: { '/things': '/tmp/things.tsx' } } })).errors.length, 1);
    assertEquals(checkUi(mod('m', { ui: { routes: { '/things': '../shared/things.tsx' } } })).errors.length, 1);
    assertEquals(checkUi(mod('m', { ui: { routes: { '/things': 'ui/pages/things.ts' } } })).errors.length, 1);
  });

  await t.step('the root, a relative path or a file-routing segment is not a route path', () => {
    // `/` is the shell's home page.
    for (const path of ['/', '', 'things', '/things/[id]', '/things//new', '//']) {
      assertEquals(checkUi(mod('m', { ui: { routes: { [path]: 'ui/pages/things.tsx' } } })).errors.length, 1, path);
    }
  });

  await t.step('ui.open names a route per node type, with {path}, {name} or {parent} its only placeholders', () => {
    const ok = { routes: { '/people/:id': 'ui/pages/person.tsx' }, open: { person: '/people/{name}', album: '/albums/{path}', track: '/devices/{parent}?tab=track' } };
    assertEquals(checkUi(mod('m', { ui: ok })).errors, []);
    const bad = { routes: { '/people/:id': 'ui/pages/person.tsx' }, open: { person: 'people/{name}', album: '/albums/{id}' } };
    assertEquals(checkUi(mod('m', { ui: bad })).errors.length, 2);
  });

  await t.step('routes that are not a map of at least one route are rejected', () => {
    assertEquals(checkUi(mod('m', { ui: { routes: {} } })).errors.length, 1);
    assertEquals(checkUi(mod('m', { ui: { routes: 'ui/app' } } as unknown as Partial<ModuleManifest>)).errors.length, 1);
  });

  await t.step('a malformed ui field is rejected', () => {
    assertEquals(checkUi(mod('m', { ui: 'ui/app' } as unknown as Partial<ModuleManifest>)).errors.length, 1);
  });
});

Deno.test('module specifier resolution', async (t) => {
  const provider = mod('people', {
    exports: { './genealogy': './lib/genealogy.ts' },
    imports: { '@people/cover': './lib/cover.ts' },
  });
  const installed = new Map([['people', provider], ['media', mod('media')]]);
  const lookup = (name: string) => installed.get(name);
  const dependent = mod('device', {
    imports: { '@std/path': 'jsr:@std/path@^1.1.3', '@device/zone': './lib/zone.ts' },
    dependencies: { people: '^0.1.0' },
  });

  await t.step("the owner's own imports come first, keeping the remainder", () => {
    assertEquals(resolveModuleSpecifier('@std/path/join', dependent, lookup), { kind: 'import', target: 'jsr:@std/path@^1.1.3/join' });
    assertEquals(resolveModuleSpecifier('@device/zone', dependent, lookup), { kind: 'import', target: './lib/zone.ts' });
  });

  await t.step("a declared dependency's export resolves to that module's file", () => {
    assertEquals(resolveModuleSpecifier('@people/genealogy', dependent, lookup), { kind: 'export', module: 'people', target: './lib/genealogy.ts' });
  });

  await t.step('a module reaches its own exports without restating them', () => {
    assertEquals(resolveModuleSpecifier('@people/genealogy', provider, lookup), { kind: 'export', module: 'people', target: './lib/genealogy.ts' });
  });

  await t.step("a provider's private alias is not reachable from outside", () => {
    const got = resolveModuleSpecifier('@people/cover', dependent, lookup);
    assertEquals(got.kind, 'error');
    assertEquals(got.kind === 'error' && got.message.includes('not exported by'), true);
  });

  await t.step('an installed module that is not a dependency is refused', () => {
    const got = resolveModuleSpecifier('@media/face-crop', dependent, lookup);
    assertEquals(got.kind === 'error' && got.message.includes("does not list 'media'"), true);
  });

  await t.step('a declared dependency that is not installed is refused', () => {
    const got = resolveModuleSpecifier('@ghost/x', mod('device', { dependencies: { ghost: '^1.0.0' } }), lookup);
    assertEquals(got.kind === 'error' && got.message.includes('is not installed'), true);
  });

  await t.step('anything else is left to core', () => {
    assertEquals(resolveModuleSpecifier('@ein/client', dependent, lookup), { kind: 'core' });
    assertEquals(resolveModuleSpecifier('react', dependent, lookup), { kind: 'core' });
  });

  await t.step('the projected import map carries own imports, own exports and dependency exports', () => {
    assertEquals(moduleImportMap(dependent, lookup), {
      '@device/zone': './lib/zone.ts',
      '@people/genealogy': '../people/lib/genealogy.ts',
      '@std/path': 'jsr:@std/path@^1.1.3',
    });
    assertEquals(moduleImportMap(provider, lookup), {
      '@people/cover': './lib/cover.ts',
      '@people/genealogy': './lib/genealogy.ts',
    });
  });
});

Deno.test('imports and exports stay inside the module', () => {
  assertEquals(checkModuleMaps(mod('ok', { exports: { './a': './lib/a.ts' }, imports: { x: 'npm:x@1', '@ok/b': './lib/b.ts' } })), []);

  const errors = checkModuleMaps(mod('bad', {
    exports: { 'a': './lib/a.ts', './b': '../other/lib/b.ts' },
    imports: { '@other/c': '../other/lib/c.ts' },
  }));
  assertEquals(errors.length, 3, errors.join('\n'));
});

Deno.test('an export may name its area, and resolves under it', () => {
  const archive = mod('archive', { exports: { './people/genealogy': './lib/people/genealogy.ts' } });
  assertEquals(checkModuleMaps(archive), []);
  assertEquals(checkModuleMaps(mod('bad', { exports: { './people/': './lib/a.ts', './People/x': './lib/b.ts' } })).length, 2);

  const user = mod('user', { dependencies: { archive: '^0.1.0' } });
  assertEquals(resolveModuleSpecifier('@archive/people/genealogy', user, (name) => (name === 'archive' ? archive : undefined)), {
    kind: 'export',
    module: 'archive',
    target: './lib/people/genealogy.ts',
  });
});
