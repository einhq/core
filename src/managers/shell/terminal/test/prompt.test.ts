import { assertEquals } from '@std/assert';
import type { ExecContextIf } from '@ein/bash-executor';
import { defaultPS1, expandPS1 } from '../prompt.ts';

/** The little of a context the prompt reads: the environment and the working directory. */
const ctx = { getEnv: () => ({ USER: 'anna', HOME: '/home/anna', HOSTNAME: 'ein.local' }), getCwd: () => '/home/anna/notes' } as unknown as ExecContextIf;

Deno.test('the prompt ends in # for an administrator and $ for anyone else', () => {
  assertEquals(expandPS1(ctx, '\\u@\\h:\\w\\$ ', false), 'anna@ein:~/notes$ ');
  assertEquals(expandPS1(ctx, '\\u@\\h:\\w\\$ ', true), 'anna@ein:~/notes# ');
});

Deno.test('the default prompt shows an administrator in red, anyone else in green', () => {
  assertEquals(expandPS1(ctx, defaultPS1(false), false), '\x1b[1m\x1b[32manna@ein\x1b[39m:\x1b[34m~/notes\x1b[39m$ \x1b[0m');
  assertEquals(expandPS1(ctx, defaultPS1(true), true), '\x1b[1m\x1b[31manna@ein\x1b[39m:\x1b[34m~/notes\x1b[39m# \x1b[0m');
});
