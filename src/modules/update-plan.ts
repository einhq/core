/** Which installed modules have to be updated together, as their ranges have it. */

import { tryParse, tryParseRange } from '@std/semver';
import { inRange } from './version.ts';

/** A module's version and the ranges it asks of the modules it depends on. */
export type Manifested = { version?: string | null; dependencies: Readonly<Record<string, string>> };

/** What updating one module takes along with it, and what keeps the update from holding. */
type Together = {
  /** The other modules updated with it, by name. */
  with: string[];
  /** Each range the update leaves unmet, said as it is. */
  held: string[];
};

/** Whether `version` is in `range`; a version or range that does not parse is not held against it. */
const accepts = (version: string | null | undefined, range: string): boolean => {
  const [parsed, parsedRange] = [tryParse(version ?? ''), tryParseRange(range)];
  return parsed === undefined || parsedRange === undefined || inRange(parsed, parsedRange);
};

const named = (name: string, module: Manifested | undefined): string => module?.version ? `${name} ${module.version}` : name;

/**
 * What updating `name` to its newer version takes along: each module whose installed range does
 * not accept a module updated, and each dependency an updated module asks a newer version of, is
 * updated too when it has a newer version, until every range between them holds or one cannot.
 * A range is judged only where it touches a module updated, so what is broken already is left out;
 * a dependency that is not installed is installed with it and holds nothing.
 *
 * @param installed every installed module, by name
 * @param newer the modules with a newer version to update to, by name, at that version
 */
export const updatesTogether = (name: string, installed: ReadonlyMap<string, Manifested>, newer: ReadonlyMap<string, Manifested>): Together => {
  const updating = new Set([name]);
  const after = (each: string) => updating.has(each) ? newer.get(each) : installed.get(each);
  let held: string[] = [];
  for (let added = true; added;) {
    added = false;
    held = [];
    for (const each of new Set([...installed.keys(), ...updating])) {
      const module = after(each);
      for (const [dependency, range] of Object.entries(module?.dependencies ?? {})) {
        if (!updating.has(each) && !updating.has(dependency)) continue;
        const provider = after(dependency);
        if (!provider || accepts(provider.version, range)) continue;
        const fix = updating.has(each) ? (updating.has(dependency) ? undefined : dependency) : each;
        if (fix !== undefined && newer.has(fix)) {
          updating.add(fix);
          added = true;
          continue;
        }
        const why = fix === dependency
          ? `${named(dependency, provider)} is installed, with nothing newer to update it to`
          : fix === each
          ? `nothing newer of ${each} takes ${named(dependency, provider)}`
          : `the newest of ${dependency} is ${provider.version ?? 'unversioned'}`;
        held.push(`${named(each, module)} needs ${dependency} ${range}, and ${why}`);
      }
    }
  }
  return { with: [...updating].filter((each) => each !== name).sort(), held };
};
