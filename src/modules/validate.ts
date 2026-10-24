/**
 * Manifest validation for `mod setup`.
 *
 * The point is that a module which cannot work says so at install time, with a message naming
 * what is missing, rather than half-installing and failing later inside a pipeline step where
 * the cause is several layers away from the symptom. `mod setup` registers bins on PATH,
 * services and pipelines — all of which are live the moment they land — so a partially wired
 * module is worse than one that refused to install.
 */

import { canParse, parse, parseRange, satisfies } from '@std/semver';
import { join } from '@std/path';
import type { Access } from '../lib/access/mod.ts';
import type { NodeVFS } from '../vfs/mod.ts';
import { validateConfigOption } from '../lib/config/registry.ts';
import { contributionsOf, validateContributions } from '../lib/contributions/registry.ts';
import { manifestConfigOptions, MODULE_API_VERSION, type ModuleManifest } from './types.ts';
import { checkModuleMaps } from './resolve.ts';
import { readModJson } from './utils.ts';

export type ValidationResult = {
  /** Problems that must stop the install. */
  errors: string[];
  /** Things worth saying but not worth refusing over. */
  warnings: string[];
};

/** Check `coreApi` against the contract this core provides. */
export const checkCoreApi = (manifest: ModuleManifest): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest.coreApi) {
    // An unversioned module still installs: this is a warning, not an error.
    warnings.push(`${manifest.name}: no coreApi declared, assuming ${MODULE_API_VERSION}`);
    return { errors, warnings };
  }

  let range;
  try {
    range = parseRange(manifest.coreApi);
  } catch {
    errors.push(`${manifest.name}: coreApi is not a valid semver range: ${manifest.coreApi}`);
    return { errors, warnings };
  }

  if (!satisfies(parse(MODULE_API_VERSION), range)) {
    errors.push(
      `${manifest.name}: needs @ein/client ${manifest.coreApi}, this core provides ${MODULE_API_VERSION}`,
    );
  }

  return { errors, warnings };
};

/** A module-relative path that stays inside the module, or the reason it is not one. */
const insideModule = (field: string, value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string`;
  if (value.startsWith('/') || value.split(/[\\/]/).includes('..')) return `${field} must stay inside the module: ${value}`;
  return undefined;
};

/**
 * A route path: absolute, of literal and `:param` segments (as module-build checks it). `/` itself
 * is the shell's home page, not a module's.
 */
const ROUTE_PATH = /^(\/(:?[A-Za-z0-9_.~-]+))+$/;

/** Validate the UI contribution without assuming a repository layout. */
export const checkUi = (manifest: ModuleManifest): ValidationResult => {
  const errors: string[] = [];
  if (manifest.ui !== undefined && (typeof manifest.ui !== 'object' || manifest.ui === null || Array.isArray(manifest.ui))) {
    errors.push(`${manifest.name}: ui must be an object`);
    return { errors, warnings: [] };
  }

  const routes: unknown = manifest.ui?.routes;
  if (routes !== undefined) {
    if (typeof routes !== 'object' || routes === null || Array.isArray(routes) || Object.keys(routes).length === 0) {
      errors.push(`${manifest.name}: ui.routes must map at least one route path to its page file`);
    } else {
      for (const [path, page] of Object.entries(routes)) {
        if (!ROUTE_PATH.test(path)) errors.push(`${manifest.name}: ui.routes: '${path}' is not a path below '/' of literal and :param segments`);
        const problem = insideModule(`ui.routes['${path}']`, page);
        if (problem) errors.push(`${manifest.name}: ${problem}`);
        else if (!(page as string).endsWith('.tsx')) errors.push(`${manifest.name}: ui.routes['${path}'] must be a .tsx page: ${page}`);
      }
    }
  }
  const open = (manifest.ui as { open?: unknown } | undefined)?.open;
  if (open !== undefined) {
    if (typeof open !== 'object' || open === null || Array.isArray(open)) {
      errors.push(`${manifest.name}: ui.open must map node types to routes`);
    } else {
      for (const [type, route] of Object.entries(open)) {
        if (typeof route !== 'string' || !route.startsWith('/') || /\{(?!path\}|name\}|parent\})/.test(route)) {
          errors.push(`${manifest.name}: ui.open['${type}'] must be a route, with {path}, {name} or {parent} as its only placeholders`);
        }
      }
    }
  }

  return { errors, warnings: [] };
};

/**
 * Check `exports` and `imports`: both stay inside the module, and every export exists.
 *
 * An error, not a warning: a dependent resolves an export the moment it runs, so a dangling one
 * is a failure deferred to somebody else's pipeline step.
 */
export const checkExports = async (
  vfs: NodeVFS,
  access: Access,
  modulePath: string,
  manifest: ModuleManifest,
): Promise<ValidationResult> => {
  const errors = checkModuleMaps(manifest);
  if (errors.length > 0) return { errors, warnings: [] };

  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (!(await vfs.exists(access, join(modulePath, target)))) {
      errors.push(`${manifest.name}: export '${key}' points at a missing file: ${target}`);
    }
  }

  return { errors, warnings: [] };
};

/**
 * Check the settings a module declares.
 *
 * Warnings rather than errors: a malformed option is dropped by the registry and
 * costs the module one knob, which is not a reason to refuse an install that would
 * otherwise put working bins, services and pipelines in place.
 */
const checkConfigOptions = (manifest: ModuleManifest): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  const declared = manifest.config?.options;
  if (declared !== undefined && !Array.isArray(declared)) {
    errors.push(`${manifest.name}: config.options must be an array`);
    return { errors, warnings };
  }

  for (const option of manifestConfigOptions(manifest)) {
    const invalid = validateConfigOption(option);
    if (invalid) warnings.push(`${manifest.name}: ${invalid}`);
  }

  return { errors, warnings };
};

const ENV_KINDS = new Set(['deployment', 'session', 'path', 'system', 'option', 'pipeline']);
const NODE_TYPE_CATEGORIES = new Set(['content', 'structure', 'system']);

/**
 * Check the node types and environment variables a module describes, and what it contributes.
 *
 * Warnings, as for settings: a malformed description is left out of the documentation, which
 * is no reason to refuse the module.
 */
export const checkReference = (manifest: ModuleManifest): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of ['nodeTypes', 'environment'] as const) {
    if (manifest[field] !== undefined && !Array.isArray(manifest[field])) errors.push(`${manifest.name}: ${field} must be an array`);
  }
  if (errors.length) return { errors, warnings };

  for (const field of ['indexes', 'roots'] as const) {
    if (manifest[field] !== undefined && !Array.isArray(manifest[field])) errors.push(`${manifest.name}: ${field} must be an array`);
  }
  if (errors.length) return { errors, warnings };
  for (const problem of validateContributions(contributionsOf(manifest))) warnings.push(`${manifest.name}: ${problem}`);

  for (const doc of manifest.nodeTypes ?? []) {
    if (!doc?.type || typeof doc.type !== 'string') warnings.push(`${manifest.name}: a node type needs a type`);
    else if (!doc.label || !doc.description) warnings.push(`${manifest.name}: node type '${doc.type}' needs a label and a description`);
    else if (!NODE_TYPE_CATEGORIES.has(doc.category)) warnings.push(`${manifest.name}: node type '${doc.type}': category must be content, structure or system`);
  }
  for (const doc of manifest.environment ?? []) {
    if (!doc?.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(doc.key)) warnings.push(`${manifest.name}: invalid environment key '${doc?.key}'`);
    else if (!doc.description) warnings.push(`${manifest.name}: environment '${doc.key}' needs a description`);
    else if (!ENV_KINDS.has(doc.kind)) warnings.push(`${manifest.name}: environment '${doc.key}': kind must be one of ${[...ENV_KINDS].join(', ')}`);
  }

  return { errors, warnings };
};

/**
 * Check that every declared dependency is installed and version-compatible.
 *
 * Reads the dependency's own mod.json rather than trusting a registry, because there is no
 * registry — `/modules` is the source of truth for what is installed.
 */
export const checkDependencies = async (
  vfs: NodeVFS,
  access: Access,
  modulesPath: string,
  manifest: ModuleManifest,
): Promise<ValidationResult> => {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
    const depManifest = await readModJson(vfs, access, join(modulesPath, depName));

    if (!depManifest) {
      errors.push(`${manifest.name}: requires module '${depName}' (${depRange}), which is not installed`);
      continue;
    }

    let range;
    try {
      range = parseRange(depRange);
    } catch {
      errors.push(`${manifest.name}: dependency '${depName}' has an invalid semver range: ${depRange}`);
      continue;
    }

    // An unparseable version on the *dependency* is the dependency's problem, not a reason to
    // refuse this install — warn and accept rather than blocking on someone else's typo.
    if (!canParse(depManifest.version)) {
      warnings.push(`${manifest.name}: dependency '${depName}' has an unparseable version '${depManifest.version}', not checked`);
      continue;
    }

    if (!satisfies(parse(depManifest.version), range)) {
      errors.push(`${manifest.name}: requires '${depName}' ${depRange}, but ${depManifest.version} is installed`);
    }
  }

  return { errors, warnings };
};

/** Run every manifest check. */
export const validateManifest = async (
  vfs: NodeVFS,
  access: Access,
  modulesPath: string,
  manifest: ModuleManifest,
): Promise<ValidationResult> => {
  // Dependencies and `@<module>/…` specifiers are both found by directory name, so a module
  // installed under another name could be depended on by neither.
  if (!(await vfs.exists(access, join(modulesPath, manifest.name, 'mod.json')))) {
    return { errors: [`${manifest.name}: must be installed as ${join(modulesPath, manifest.name)}, the directory named after it`], warnings: [] };
  }

  const results = [
    checkCoreApi(manifest),
    await checkDependencies(vfs, access, modulesPath, manifest),
    await checkExports(vfs, access, join(modulesPath, manifest.name), manifest),
    checkUi(manifest),
    checkConfigOptions(manifest),
    checkReference(manifest),
  ];

  return {
    errors: results.flatMap((result) => result.errors),
    warnings: results.flatMap((result) => result.warnings),
  };
};
