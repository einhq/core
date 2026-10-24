/**
 * `@ein/testing` — the test-side companion to `@ein/client`.
 *
 * Without it a module's tests would reach core by relative path (`../../../src/testing/mod.ts`),
 * which ties them to this repo's directory layout. This is the same boundary as `@ein/client`,
 * for the harness rather than the command API.
 *
 * Deliberately re-exports `ADMIN_ACCESS` and the VFS types the harness hands back, so a module
 * test needs one import rather than four, and none of them a path into `src/`.
 */

/* Harness and shell client */
export { createSystemTestContext, type PrimaryContext, SystemTestHarness, type SystemTestOptions } from '../testing/system-test-harness.ts';
export { createTestContext, type TestContext } from '../testing/test-context.ts';
export { createTestVfs, type TestVfs } from '../testing/test-vfs.ts';
export { type CommandResult, type ExecOptions, ShellClient } from '../testing/shell-client.ts';

/* Assertions */
export {
  assertErrorContains,
  assertFailure,
  assertResultContains,
  assertResultEquals,
  assertResultLength,
  assertResultMatches,
  assertSuccess,
  CommandTest,
  testCommands,
} from '../testing/assertions.ts';

/* Fixtures */
export { captureTime, type DirectorySetup, type FileSetup, fixtures, setupBasicTestDir, setupDirectories, setupNestedDirs } from '../testing/fixtures.ts';

/* Tier gates — a module's PG/container tests skip the same way core's do */
export { containerTest, IN_CONTAINER, PG_URL, pgTest, type PgTestContext, pgTestContext } from '../testing/gates.ts';

/* Re-exported so a test needs no path into src/ */
export { ADMIN_ACCESS, GUEST_ACCESS, modeUnder } from '../lib/access/constants.ts';
export type { Access } from '../lib/access/types.ts';
export type { NodeVFS } from '../vfs/node-vfs.ts';
export type { Node, NodeAttrs, NodeId, NodePath, NodeType } from '../vfs/node.ts';

/* A test that stands in for a module declaring contributions (`mod.json`) registers them itself. */
export { registerContributions, unregisterContributions } from '../lib/contributions/registry.ts';
