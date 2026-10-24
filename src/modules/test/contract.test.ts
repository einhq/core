/**
 * The module contract changes only with its version.
 *
 * `MODULE_API_VERSION` is what a module's `coreApi` range is checked against. This compares the contract's surface
 * (`scripts/contract.ts`) with the snapshot of the version it claims to be: an added symbol, or an
 * interface or object type that only gained members, needs a compatible bump; a removed or changed one a breaking bump,
 * and after bumping the snapshot is rewritten with `deno task contract:snapshot`. As in semver's caret ranges, below
 * 1.0.0 the minor is the breaking part and the patch the compatible one; from 1.0.0 the major and the minor.
 */

import { assert, assertEquals } from '@std/assert';
import { contractSurface, readSnapshot } from '../../../scripts/contract.ts';
import { MODULE_API_VERSION } from '../types.ts';

type Symbol = { hash: string; members?: Map<string, string> };

const bySymbol = (lines: string[]): Map<string, Symbol> =>
  new Map(lines.map((line) => {
    const [entry, name, hash, members] = line.split(' ');
    return [`${entry} ${name}`, { hash, ...(members ? { members: new Map(members.split(',').map((m) => m.split('=') as [string, string])) } : {}) }];
  }));

/** An interface or object type that kept every member it had, unchanged, and only gained some: nothing a module used is gone. */
const onlyExtended = (was: Symbol, now: Symbol): boolean => !!was.members && !!now.members && [...was.members].every(([name, hash]) => now.members!.get(name) === hash);

const parts = (version: string): number[] => version.split('.').map(Number);

/** How far `now` moved from `was`: a breaking bump, a compatible one, or none. */
const bumpOf = (was: string, now: string): 'breaking' | 'compatible' | 'none' => {
  const [wasMajor, wasMinor, wasPatch] = parts(was);
  const [isMajor, isMinor, isPatch] = parts(now);
  if (isMajor !== wasMajor) return isMajor > wasMajor ? 'breaking' : 'none';
  if (isMajor === 0) return isMinor > wasMinor ? 'breaking' : isMinor === wasMinor && isPatch > wasPatch ? 'compatible' : 'none';
  return isMinor > wasMinor ? 'compatible' : 'none';
};

Deno.test('the module contract changes only with its version', async () => {
  const snapshot = await readSnapshot();
  const was = bySymbol(snapshot.lines);
  const now = bySymbol(await contractSurface());

  const removed = [...was.keys()].filter((key) => !now.has(key));
  const added = [...now.keys()].filter((key) => !was.has(key));
  const differs = [...now.keys()].filter((key) => was.has(key) && was.get(key)!.hash !== now.get(key)!.hash);
  const extended = differs.filter((key) => onlyExtended(was.get(key)!, now.get(key)!));
  const changed = differs.filter((key) => !extended.includes(key));
  const needed = removed.length || changed.length ? 'breaking' : added.length || extended.length ? 'compatible' : 'none';
  const bumped = bumpOf(snapshot.version, MODULE_API_VERSION);

  const detail = [
    ...removed.map((key) => `  removed  ${key}`),
    ...changed.map((key) => `  changed  ${key}`),
    ...extended.map((key) => `  extended ${key}`),
    ...added.map((key) => `  added    ${key}`),
  ].join('\n');

  if (needed === 'none') {
    assertEquals(MODULE_API_VERSION, snapshot.version, 'MODULE_API_VERSION moved but the contract did not: run `deno task contract:snapshot`');
    return;
  }
  assert(
    bumped === 'breaking' || (bumped === 'compatible' && needed === 'compatible'),
    `the module contract changed without a ${needed} bump of MODULE_API_VERSION (src/modules/types.ts, now ${MODULE_API_VERSION}):\n${detail}\n` +
      'bump it, then run `deno task contract:snapshot`',
  );
  assert(false, `MODULE_API_VERSION is ${MODULE_API_VERSION} but the snapshot is ${snapshot.version}: run \`deno task contract:snapshot\`\n${detail}`);
});
