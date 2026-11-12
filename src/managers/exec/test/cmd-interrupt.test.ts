/**
 * `onInterrupt` reaches a command whenever it starts listening: a handler set before a
 * terminating signal fires on it, and one set after it fires at once. A ^C on a command whose
 * stderr is closed is taken without an error.
 */

import { assertEquals } from '@std/assert';
import { Cmd } from '../cmd.ts';
import type { ExecutionManager } from '../execution-manager.ts';
import type { SystemCore } from '../../../system-core.ts';
import type { CmdOpts } from '../types.ts';

const command = () => new Cmd({} as SystemCore, {} as ExecutionManager, 'cmd-1', 'test', {}, {} as CmdOpts);

/** A foreground command whose stderr was closed under it. */
class ClosedStderr extends Cmd {
  constructor() {
    super({} as SystemCore, {} as ExecutionManager, 'cmd-2', 'test', {}, {} as CmdOpts);
    this._stderr = { write: () => Promise.reject(new Error('handle is closed')) } as unknown as typeof this._stderr;
  }
}

Deno.test('a ^C on a command whose stderr is closed is taken without an error', async () => {
  const cmd = new ClosedStderr();
  await cmd.kill('SIGINT');
  assertEquals(cmd.interrupted, true);
});

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
