/**
 * Loop and command-substitution semantics, through the real shell, in the shapes a scan over the
 * VFS takes: a failing command substitution does not abort the command it appears in, and a
 * failing loop body does not end the loop.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

// `boot: true` for /dev/null — these scripts send stderr there, as any scan does.
const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'shell loops',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    // Two directories with children, one without — like people who have no events.
    await client.execString('mkdir /tmp/loops && mkdir /tmp/loops/a && mkdir /tmp/loops/b && mkdir /tmp/loops/c');
    await client.execString('mkdir /tmp/loops/a/events && mkdir /tmp/loops/c/events');
    await client.execString('mkdir /tmp/loops/a/events/e1 && mkdir /tmp/loops/a/events/e2 && mkdir /tmp/loops/c/events/e3');

    /** The API shell sets JSON_OUTPUT=1; these run `ls` the way a person at the shell does. */
    const run = (script: string) => client.execString(`export JSON_OUTPUT=0\n${script}`);

    await t.step('nested for over a command substitution counts every branch', async () => {
      const out = await run(`
        total=0
        for p in $(ls /tmp/loops); do
          for e in $(ls /tmp/loops/$p/events 2>/dev/null); do
            total=$((total+1))
          done
        done
        echo "total=$total"
      `);
      assertEquals(out.trim(), 'total=3');
    });

    await t.step('a loop feeding a pipe writes every iteration', async () => {
      const out = await run(`for p in $(ls /tmp/loops); do ls /tmp/loops/$p/events 2>/dev/null; done | wc -l`);
      assertEquals(out.trim(), '3');
    });

    await t.step('the loop runs on past a failing iteration', async () => {
      const out = await run(`for p in $(ls /tmp/loops); do ls /tmp/loops/$p/events 2>/dev/null > /dev/null; echo "at=$p"; done`);
      assertEquals(out.trim().split('\n'), ['at=a', 'at=b', 'at=c']);
    });

    await t.step('a failing command substitution does not swallow the command around it', async () => {
      const out = await run(`echo "[$(ls /tmp/loops/b/events 2>/dev/null)]"`);
      assertEquals(out.trim(), '[]');
    });

    await t.step('break still leaves the loop', async () => {
      const out = await run(`for p in $(ls /tmp/loops); do echo "at=$p"; break; done`);
      assertEquals(out.trim(), 'at=a');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
