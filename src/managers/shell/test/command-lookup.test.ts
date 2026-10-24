/**
 * Finding an external command on `$PATH`.
 *
 * Two things are under test and they pull in opposite directions: the lookup is memoised, and it
 * still has to give the answers an un-memoised scan would. So every case here is written against
 * the shell, end to end, rather than against the cache — what matters is that `foo` runs the right
 * `foo`, not how few round trips it took to decide that.
 */

import { BIN_PATH } from '../../../lib/paths.ts';
import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { clearCommandLookupCache, lookupCommandPath } from '../command-lookup.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({
  name: 'command lookup on $PATH',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  /** A shell script bin at `path`, executable, echoing `line`. */
  const writeBin = async (path: string, line: string): Promise<void> => {
    await client.exec(`echo 'echo ${line}' > ${path}`);
    await client.exec(`chmod 755 ${path}`);
  };

  // Two directories holding a command of the same name, so PATH order is observable.
  await client.exec('mkdir -p /opt/first');
  await client.exec('mkdir -p /opt/second');
  await writeBin('/opt/second/shared-cmd', 'from-second');
  await writeBin('/opt/second/second-only', 'only-in-second');

  const withPath = (script: string) => `export PATH="$PATH:/opt/missing:/opt/first:/opt/second" && ${script}`;

  await t.step('a PATH entry that does not exist is skipped, not fatal', async () => {
    // /opt/missing is never created: a PATH entry with no directory behind it is skipped.
    const out = await client.execString(withPath('second-only'));
    assertEquals(out.trim(), 'only-in-second');
  });

  await t.step('the first PATH entry holding the name wins', async () => {
    assertEquals((await client.execString(withPath('shared-cmd'))).trim(), 'from-second');

    // Same name, earlier directory: the answer must change even though the old one was just
    // memoised under this very PATH.
    await writeBin('/opt/first/shared-cmd', 'from-first');
    clearCommandLookupCache();

    assertEquals((await client.execString(withPath('shared-cmd'))).trim(), 'from-first');
  });

  await t.step('a name on no PATH entry is reported not found, with status 127', async () => {
    const result = await client.exec(withPath('definitely-not-a-command'));
    assertStringIncludes(JSON.stringify(result), 'not found');
    assertMatch(await client.execString(withPath('definitely-not-a-command 2>&1; echo "st=$?"')), /not found\nst=127\n$/);
  });

  await t.step('a command added after a negative answer is found once the cache is cleared', async () => {
    // The staleness the TTL bounds, made deterministic: a miss is memoised too, so a bin that
    // appears afterwards is invisible until the entry expires or something drops it.
    const result = await client.exec(withPath('late-cmd'));
    assertStringIncludes(JSON.stringify(result), 'not found');

    await writeBin('/opt/first/late-cmd', 'arrived');
    clearCommandLookupCache();

    assertEquals((await client.execString(withPath('late-cmd'))).trim(), 'arrived');
  });

  await t.step('$PATH is part of the key, so two shells do not share an answer', async () => {
    // Same name, different PATH: the entry memoised above must not answer for a PATH that cannot
    // see /opt at all.
    clearCommandLookupCache();
    assertEquals(await lookupCommandPath(vfs, '/opt/first:/opt/second', 'shared-cmd'), '/opt/first/shared-cmd');
    assertEquals(await lookupCommandPath(vfs, BIN_PATH, 'shared-cmd'), undefined);
  });

  await t.step('a core command runs when named by its absolute path', async () => {
    // A command node named by absolute path runs: the registry is keyed by name, not path.
    const out = await client.execString(`${BIN_PATH}/uuid`);
    assertEquals(/^[0-9a-f-]{36}$/.test(out.trim()), true, out);
  });

  await t.step('the lookup does not need the caller to be able to read the directory', async () => {
    // It answers "does this exist", not "may this caller run it" — the shell asserts execute
    // access on the node it gets back.
    await vfs.update(ADMIN_ACCESS, '/opt/second', { props: { mode: 0o700 } });
    assertEquals(await lookupCommandPath(vfs, '/opt/second', 'second-only'), '/opt/second/second-only');
  });

  client.close();
  await harness.stop();
});
