/**
 * Test Context
 *
 * Thin convenience wrapper around SystemTestHarness for command tests.
 * Boots an in-memory primary (HTTP only, no SSH) and hands out logged-in
 * shell clients.
 */

import type { ExecutionManager } from '../managers/exec/mod.ts';
import type { RouterManager } from '../managers/router/mod.ts';
import type { Shell } from '../managers/shell/shell.ts';
import type { NodeVFS } from '../vfs/mod.ts';
import type { ShellClient } from './shell-client.ts';
import { SystemTestHarness, type SystemTestOptions } from './system-test-harness.ts';

export type TestContext = {
  vfs: NodeVFS;
  cem: ExecutionManager;
  router: RouterManager;
  shell: Shell;
  baseUrl: string;
  port: number;
};

export function createTestContext(options: SystemTestOptions = {}) {
  const harness = new SystemTestHarness({ ssh: false, ...options });
  let ctx: TestContext | undefined;

  return {
    harness,

    server: {
      createShellClient(opts?: { username?: string; password?: string; login?: boolean }): Promise<ShellClient> {
        return harness.createShellClient(opts);
      },
    },

    async setup(): Promise<TestContext> {
      const primary = await harness.startPrimary();
      ctx = {
        vfs: primary.vfs,
        cem: primary.cem,
        router: primary.routerManager,
        shell: primary.shell,
        baseUrl: primary.baseUrl,
        port: primary.httpPort,
      };
      return ctx;
    },

    async teardown(): Promise<void> {
      await harness.stop();
      ctx = undefined;
    },

    get context(): TestContext {
      if (!ctx) throw new Error('test context not set up, call setup() first');
      return ctx;
    },
  };
}
