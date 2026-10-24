/**
 * Testing Module
 *
 * Provides utilities for testing terminal commands.
 *
 * Usage:
 * ```typescript
 * import { createTestContext, ShellClient, testCommands } from './testing/mod.ts';
 *
 * const testCtx = createTestContext();
 *
 * Deno.test('my test', async (t) => {
 *   await testCtx.setup();
 *   const client = await testCtx.server.createShellClient();
 *
 *   try {
 *     const result = await client.exec('ls /');
 *     // assertions...
 *   } finally {
 *     client.close();
 *     await testCtx.teardown();
 *   }
 * });
 * ```
 */

export { createTestContext, type TestContext } from './test-context.ts';
export { createTestVfs, type TestVfs, type TestVfsOptions } from './test-vfs.ts';
export { expandModuleDeps } from './module-deps.ts';
export { createSystemTestContext, type PrimaryContext, SystemTestHarness, type SystemTestOptions } from './system-test-harness.ts';
export { type CommandResult, type ExecOptions, ShellClient } from './shell-client.ts';
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
} from './assertions.ts';
export { captureTime, type DirectorySetup, type FileSetup, fixtures, setupBasicTestDir, setupDirectories, setupNestedDirs } from './fixtures.ts';
