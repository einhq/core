/**
 * What the shell lends to module bundles at runtime.
 *
 * A module's UI is bundled on its own, so it cannot carry a second React or a second
 * Mantine: hooks and context only work against the one instance the shell renders with.
 * The shell therefore puts each of these on `globalThis[SHARED_GLOBAL]` under its
 * specifier (`src/client/lend.ts`, type-checked against the lists here), and a module build maps the specifier to a one-line CommonJS shim reading
 * it back, which esbuild turns into property reads. A browser import map of separate
 * vendor files does not work here: React and react-dom are CommonJS, and a CommonJS
 * package bundled on its own keeps a `require("react")` the browser cannot run.
 *
 * A module bundle depends on these names, not on the packages' versions, so the
 * runtime id below covers the list alone: upgrading React leaves every built module
 * bundle valid, while adding or removing a name rebuilds them.
 */
export const SHARED_GLOBAL = '__EIN_UI__';

/**
 * Specifiers resolved through the shell's own import map: `'*'` lends the whole
 * namespace, a list only those names.
 *
 * Mantine is lent whole (~170 KB of the shell) because it is the UI framework and a
 * module page may use any of it. react-router-dom is not: its namespace is mostly the
 * server and framework side (static handlers, hydration), ~100 KB a module never
 * touches, so only the client's hooks and components are lent. A listed package's shim
 * has named exports, so a module importing a name outside the list fails its build
 * instead of finding `undefined` at runtime.
 */
export const SHARED_PACKAGES = {
  'react': '*',
  'react/jsx-runtime': '*',
  'react-dom': '*',
  'react-router-dom': [
    'Form',
    'Link',
    'NavLink',
    'Navigate',
    'Outlet',
    'createSearchParams',
    'data',
    'generatePath',
    'isRouteErrorResponse',
    'matchPath',
    'redirect',
    'replace',
    'useActionData',
    'useBeforeUnload',
    'useBlocker',
    'useFetcher',
    'useHref',
    'useInRouterContext',
    'useLoaderData',
    'useLocation',
    'useMatch',
    'useMatches',
    'useNavigate',
    'useNavigation',
    'useNavigationType',
    'useOutletContext',
    'useParams',
    'useResolvedPath',
    'useRevalidator',
    'useRouteError',
    'useRouteLoaderData',
    'useSearchParams',
    'useSubmit',
  ],
  '@mantine/core': '*',
  '@mantine/dates': '*',
  '@mantine/hooks': '*',
  '@hello-pangea/dnd': '*',
  '@preact/signals-react': '*',
  '@preact/signals-react/runtime': '*',
  '@ein/paths': '*',
} as const satisfies Record<string, '*' | readonly string[]>;

/** The shell's kit, by specifier, relative to the client source directory; lent whole. */
const SHARED_KIT = {
  '@ein/ui/components': 'components/mod.ts',
  '@ein/ui/hooks': 'hooks/mod.ts',
  '@ein/ui/lib': 'lib/mod.ts',
  '@ein/ui/signals': 'signals/mod.ts',
  '@ein/ui/theme': 'theme/mod.ts',
} as const satisfies Record<string, string>;

/** A lent specifier. */
export type SharedSpecifier = keyof typeof SHARED_PACKAGES | keyof typeof SHARED_KIT;

/** Every lent specifier with what it lends, in a stable order. */
export const sharedSpecifiers = (): Record<string, '*' | readonly string[]> =>
  Object.fromEntries(
    [...Object.entries(SHARED_PACKAGES), ...Object.keys(SHARED_KIT).map((s): [string, '*'] => [s, '*'])]
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** The shell runtime a module bundle is built against. */
type UiRuntime = {
  /** Changes exactly when the shared list does. */
  id: string;
  global: string;
  shared: Record<string, '*' | readonly string[]>;
};

/**
 * cyrb53, a 53-bit string hash. Not SHA-256: the shell computes the id too, to compare it with
 * the manifest's, and `crypto.subtle` is missing from a page served over plain http.
 */
const hash53 = (text: string): number => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

export const uiRuntime = (): UiRuntime => {
  const shared = sharedSpecifiers();
  return { id: hash53(JSON.stringify([SHARED_GLOBAL, shared])).toString(16).padStart(14, '0').slice(0, 12), global: SHARED_GLOBAL, shared };
};

/**
 * Where a module's page sources find what the shell lends, for type-checking them in a core
 * checkout: the kit at the shell's client sources (`kitDir`, relative to the module's root:
 * `../../src/builtin/ui/src/client` from `modules/<name>`), each package at the version core pins
 * (`coreImports`, `deno.jsonc` `imports`). `@ein/paths`, a file of core's, resolves through core's
 * map as it is. Only types depend on this: `ui-build` bundles a module's pages against the runtime,
 * never these.
 */
export const lentTypePaths = (coreImports: Record<string, string>, kitDir: string): Record<string, string> => {
  const paths: Record<string, string> = {};
  for (const specifier of Object.keys(SHARED_PACKAGES)) {
    const target = coreImports[specifier];
    if (target !== undefined && /^(npm|jsr):/.test(target)) paths[specifier] = target;
  }
  for (const [specifier, file] of Object.entries(SHARED_KIT)) paths[specifier] = `${kitDir}/${file}`;
  return paths;
};
