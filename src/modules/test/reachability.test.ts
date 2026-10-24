/**
 * Reachability suite — every source file under `src/` and `modules/` is reached from an entry
 * point, and every export of a reached file is used.
 *
 * Code no entry point reaches is dead even when a test or a script still imports it (wow/code.md,
 * "Dead code"), so tests, `scripts/`, `eval/` and `src/testing/` are walked from nowhere. The
 * graph and its entry points are `source-graph.ts`'s.
 */

import { assertEquals } from '@std/assert';
import { join, relative } from '@std/path';
import { CONTRACT_ENTRIES } from '../../../scripts/contract.ts';
import { REPO_ROOT } from '../repo.ts';
import { sourceGraph, unusedExports } from './source-graph.ts';

/** Files kept although nothing reaches them, each with the reason. */
const ALLOWED_FILES: Record<string, string> = {
  'src/client/testing.ts': "`@ein/testing`, the contract's harness for module tests; only tests import it",
};

/** Exports kept although nothing outside tests uses them, as `path: name`, each with the reason. */
const ALLOWED_EXPORTS: Record<string, string> = {};

/** Files whose exports are a published interface, so every one counts as used: the module contract. */
const CONTRACT = new Set([...CONTRACT_ENTRIES, 'src/client/testing.ts'].map((path) => join(REPO_ROOT, path)));

const graph = await sourceGraph();

Deno.test('every source file is reached from an entry point', () => {
  assertEquals(graph.sources.length > 500, true, `only found ${graph.sources.length} sources`);
  assertEquals(graph.reached.size > 500, true, `only reached ${graph.reached.size} files`);

  const dead = graph.sources
    .filter((path) => !graph.reached.has(path))
    .map((path) => relative(REPO_ROOT, path))
    .filter((path) => !Object.hasOwn(ALLOWED_FILES, path))
    .sort();
  const stale = Object.keys(ALLOWED_FILES).filter((path) => !graph.sources.includes(join(REPO_ROOT, path)) || graph.reached.has(join(REPO_ROOT, path)));

  assertEquals(dead, [], `no entry point reaches these files; delete them, or allow one in ALLOWED_FILES with a reason:\n  ${dead.join('\n  ')}`);
  assertEquals(stale, [], `ALLOWED_FILES lists files that are reached or gone:\n  ${stale.join('\n  ')}`);
});

Deno.test('every export of a reached file is used', () => {
  const found = unusedExports(graph, CONTRACT);
  const offenders = found
    .filter(({ path, name }) => !Object.hasOwn(ALLOWED_EXPORTS, `${path}: ${name}`))
    .map(({ path, name, fix }) => `${path}: ${name} — ${fix === 'unexport' ? 'only its own file uses it; drop the export' : 'nothing uses it but tests; delete it'}`);
  const stale = Object.keys(ALLOWED_EXPORTS).filter((key) => !found.some(({ path, name }) => `${path}: ${name}` === key));

  assertEquals(offenders, [], `unused exports; fix them, or allow one in ALLOWED_EXPORTS with a reason:\n  ${offenders.join('\n  ')}`);
  assertEquals(stale, [], `ALLOWED_EXPORTS lists exports that are used or gone:\n  ${stale.join('\n  ')}`);
});
