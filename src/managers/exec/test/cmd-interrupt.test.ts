/**
 * `onInterrupt` reaches a command whenever it starts listening: a handler set before a
 * terminating signal fires on it, and one set after it fires at once.
 */

import { assertEquals } from '@std/assert';
import { Cmd } from '../cmd.ts';
import type { ExecutionManager } from '../execution-manager.ts';
import type { SystemCore } from '../../../system-core.ts';
import type { CmdOpts } from '../types.ts';

const command = () => new Cmd({} as SystemCore, {} as ExecutionManager, 'cmd-1', 'test', {}, {} as CmdOpts);

Deno.test('a handler set before SIGTERM fires on it', async () => {
  const cmd = command();
  let calls = 0;
  cmd.onInterrupt(() => calls++);

  await cmd.kill('SIGTERM');

  assertEquals(calls, 1);
});

Deno.test('a handler set after SIGTERM fires at once', async () => {
  const cmd = command();
  await cmd.kill('SIGTERM');

  let calls = 0;
  cmd.onInterrupt(() => calls++);

  assertEquals(calls, 1);
});

Deno.test('a non-terminating signal neither fires a handler nor arms a later one', async () => {
  const cmd = command();
  let calls = 0;
  cmd.onInterrupt(() => calls++);
  await cmd.kill('SIGTSTP');
  cmd.onInterrupt(() => calls++);

  assertEquals(calls, 0);
});
