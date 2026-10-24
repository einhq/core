import { assertEquals } from '@std/assert';
import type { Command } from '../../../command.ts';
import { fmtAge, fmtTty, lastColumnRoom } from '../lib.ts';

Deno.test('system command text', async (t) => {
  await t.step('an age is said in the two units that matter at its length', () => {
    assertEquals([999, 42_000, 243_000, 11_520_000, 356_400_000].map(fmtAge), ['0s', '42s', '4m03s', '3h12m', '4d03h']);
    assertEquals(fmtAge(-5000), '0s', 'a clock a little ahead is not a negative age');
  });

  await t.step("a service's shell is named by the service, any other by its origin and name's end", () => {
    assertEquals(fmtTty('tty-01J0000000000000000000ABCD', 'service', 'pipeline-engine'), 'pipeline-engine');
    assertEquals(fmtTty('tty-01J0000000000000000000ABCD', 'ssh'), 'ssh/ABCD');
  });

  await t.step('the last column has what the terminal leaves it, and no edge through a pipe', () => {
    const rows = [{ PID: 'ls-01J', USER: 'anna', COMMAND: 'ls -l' }];
    const terminal = { tty: true, cols: 40 } as Command;
    // `PID   ` (6 + 1) and `USER ` (4 + 1) leave 28 of 40.
    assertEquals(lastColumnRoom(terminal, rows, ['PID', 'USER']), 28);
    assertEquals(lastColumnRoom({ tty: true, cols: 10 } as Command, rows, ['PID', 'USER']), 8, 'never narrower than a word');
    assertEquals(lastColumnRoom({ tty: false, cols: 40 } as Command, rows, ['PID', 'USER']), Infinity);
  });
});
