/**
 * What the shell lends to module bundles, on `globalThis.__EIN_UI__` by specifier, set before
 * any module bundle can be imported (see `@ui/shared` for why, and for the lists). The
 * `satisfies` clauses hold this to those lists: a specifier or a name missing here, or here and
 * not there, fails `deno check`.
 *
 * react-router-dom is lent by name, not as a namespace: reading its namespace by a computed key
 * would keep all of it in the shell, ~100 KB of server and framework code a module never uses.
 */
import * as paths from '@ein/paths';
import * as dnd from '@hello-pangea/dnd';
import * as mantineCore from '@mantine/core';
import * as mantineDates from '@mantine/dates';
import * as mantineHooks from '@mantine/hooks';
import * as signals from '@preact/signals-react';
import * as signalsRuntime from '@preact/signals-react/runtime';
import { SHARED_GLOBAL, type SHARED_PACKAGES, type SharedSpecifier } from '@ui/shared';
import * as react from 'react';
import * as reactDom from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import {
  createSearchParams,
  data,
  Form,
  generatePath,
  isRouteErrorResponse,
  Link,
  matchPath,
  Navigate,
  NavLink,
  Outlet,
  redirect,
  replace,
  useActionData,
  useBeforeUnload,
  useBlocker,
  useFetcher,
  useHref,
  useInRouterContext,
  useLoaderData,
  useLocation,
  useMatch,
  useMatches,
  useNavigate,
  useNavigation,
  useNavigationType,
  useOutletContext,
  useParams,
  useResolvedPath,
  useRevalidator,
  useRouteError,
  useRouteLoaderData,
  useSearchParams,
  useSubmit,
} from 'react-router-dom';
import * as components from './components/mod.ts';
import * as hooks from './hooks/mod.ts';
import * as lib from './lib/mod.ts';
import * as uiSignals from './signals/mod.ts';
import * as theme from './theme/mod.ts';

type RouterName = typeof SHARED_PACKAGES['react-router-dom'][number];

const router = {
  Form,
  Link,
  NavLink,
  Navigate,
  Outlet,
  createSearchParams,
  data,
  generatePath,
  isRouteErrorResponse,
  matchPath,
  redirect,
  replace,
  useActionData,
  useBeforeUnload,
  useBlocker,
  useFetcher,
  useHref,
  useInRouterContext,
  useLoaderData,
  useLocation,
  useMatch,
  useMatches,
  useNavigate,
  useNavigation,
  useNavigationType,
  useOutletContext,
  useParams,
  useResolvedPath,
  useRevalidator,
  useRouteError,
  useRouteLoaderData,
  useSearchParams,
  useSubmit,
} satisfies Record<RouterName, unknown>;

const lent = {
  'react': react,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': reactDom,
  'react-router-dom': Object.freeze(router),
  '@mantine/core': mantineCore,
  '@mantine/dates': mantineDates,
  '@mantine/hooks': mantineHooks,
  '@hello-pangea/dnd': dnd,
  '@preact/signals-react': signals,
  '@preact/signals-react/runtime': signalsRuntime,
  '@ein/paths': paths,
  '@ein/ui/components': components,
  '@ein/ui/hooks': hooks,
  '@ein/ui/lib': lib,
  '@ein/ui/signals': uiSignals,
  '@ein/ui/theme': theme,
} satisfies Record<SharedSpecifier, unknown>;

(globalThis as Record<string, unknown>)[SHARED_GLOBAL] = Object.freeze(lent);
