import { createLogger } from '../../managers/logger/mod.ts';
import { ARCHIVE_PATH } from '../paths.ts';
import { NAME_LANGUAGES } from '../../vfs/query.ts';
import type { Completion, Contributions } from './types.ts';

const logger = createLogger('contributions');

/**
 * What the installed modules contribute to core's own machinery: which entities an `@` completes,
 * the node types in `mod.json` `nodeTypes` that have a `root`. Registered by `mod setup` and
 * dropped by `mod remove`, in memory like the settings table — `mod setup --all` runs at every boot.
 *
 * Indexes and archive roots are declared the same way but live in the store and the tree, so
 * `mod setup` creates them rather than registering them here.
 */
const byOwner = new Map<string, Contributions>();

/** A node type as an `@` completes it — by its type — and where its nodes are; nothing for a type with no root. */
const completionOf = (nodeType: NonNullable<Contributions['nodeTypes']>[number]): [string, Completion] | undefined =>
  nodeType.root === undefined ? undefined : [nodeType.type, { type: nodeType.type, root: nodeType.root }];

const completionsOf = (declared: Contributions): Record<string, Completion> =>
  Object.fromEntries((declared.nodeTypes ?? []).map(completionOf).filter((entry) => entry !== undefined));

const NAME = /^[A-Za-z0-9][\w-]*$/;
const ATTR = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/;
const ROOT = new RegExp(`^${ARCHIVE_PATH}/[a-z][a-z0-9_-]*$`);

/** Why a module's declarations cannot be registered, one reason per bad entry. */
export const validateContributions = (declared: Contributions): string[] => {
  const problems: string[] = [];
  for (const nodeType of declared.nodeTypes ?? []) {
    if (nodeType?.root === undefined) continue;
    if (!NAME.test(String(nodeType.type))) problems.push(`node type: invalid type '${nodeType.type}'`);
    else if (typeof nodeType.root !== 'string' || !nodeType.root.startsWith('/')) problems.push(`node type '${nodeType.type}': root must be an absolute path`);
  }
  for (const index of declared.indexes ?? []) {
    if (!index || !/^[a-z][a-z0-9_]*$/.test(String(index.name))) problems.push(`index: invalid name '${index?.name}' (lower case, digits, _)`);
    else if (!Array.isArray(index.on) || index.on.length === 0 || !index.on.every((attr) => ATTR.test(String(attr)))) {
      problems.push(`index '${index.name}': 'on' must list attrs`);
    } else if (index.partial !== undefined && !ATTR.test(String(index.partial))) problems.push(`index '${index.name}': invalid partial attr '${index.partial}'`);
    else if (index.collation !== undefined && index.collation !== 'bytes' && !(NAME_LANGUAGES as readonly string[]).includes(index.collation)) {
      problems.push(`index '${index.name}': collation must be bytes or one of ${NAME_LANGUAGES.join(', ')}`);
    } else if (index.using !== undefined && index.using !== 'trigram' && index.using !== 'statistics') {
      problems.push(`index '${index.name}': using must be trigram or statistics`);
    } else if (index.using === 'trigram' && (index.on.length !== 1 || index.collation !== undefined)) {
      problems.push(`index '${index.name}': a trigram index is on one attr, and has no collation`);
    } else if (index.using === 'statistics' && (index.on.length !== 1 || index.collation !== undefined || index.partial !== undefined)) {
      problems.push(`index '${index.name}': statistics are on one attr, with no collation or partial`);
    }
  }
  for (const root of declared.roots ?? []) {
    if (typeof root !== 'string' || !ROOT.test(root)) problems.push(`root: '${String(root)}' is not a directory directly under ${ARCHIVE_PATH}`);
  }
  return problems;
};

/** The declarations of `Contributions` a manifest carries, and nothing else of it. */
export const contributionsOf = (manifest: Contributions): Contributions => ({
  ...(manifest.nodeTypes ? { nodeTypes: manifest.nodeTypes.map((nodeType) => ({ type: nodeType?.type, root: nodeType?.root })) } : {}),
  ...(manifest.indexes ? { indexes: manifest.indexes } : {}),
  ...(manifest.roots ? { roots: manifest.roots } : {}),
});

/**
 * Register a module's contributions, replacing what it registered before. A node type another
 * module registered first is declined: the first owner keeps it. False
 * when the declarations are invalid and nothing was registered — nor may their indexes or roots
 * be created, which are names spliced into DDL and paths.
 */
export const registerContributions = (owner: string, declared: Contributions): boolean => {
  const problems = validateContributions(declared);
  if (problems.length > 0) logger.warn('module contributions ignored', { owner, problems });
  if (problems.length > 0) return false;

  const taken = new Set([...byOwner].filter(([name]) => name !== owner).flatMap(([, value]) => Object.keys(completionsOf(value))));
  byOwner.set(owner, {
    ...declared,
    nodeTypes: declared.nodeTypes?.filter((nodeType) => {
      const completion = completionOf(nodeType);
      if (!completion || !taken.has(completion[0])) return true;
      logger.warn('module completion ignored, already registered', { owner, key: completion[0] });
      return false;
    }),
  });
  return true;
};

/** Drop what a module registered. */
export const unregisterContributions = (owner: string): boolean => byOwner.delete(owner);

/** Every completable entity kind, by the word typed after the `@`. */
export const completions = (): Record<string, Completion> => Object.assign({}, ...[...byOwner.values()].map(completionsOf));
