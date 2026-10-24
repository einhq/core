/**
 * Every command says whether it changes anything.
 *
 * The assistant finds and runs any command, and runs a read at once but shows a write to the user
 * first (`judgeLine`, `src/managers/exec/effect.ts`). A command without `effect` is judged a
 * write, which is safe but asks the user about every `ls`-like call; so every command on PATH,
 * core and module alike, must declare it — and a flag that makes a writing command report instead
 * (`--dry-run`) must say so, or the assistant cannot look before it leaps without asking.
 *
 * Read through `--help`, the route the assistant itself uses.
 */

import { assertEquals } from '@std/assert';
import { type CmdSpec, judgeLine } from '../../client/mod.ts';
import { createTestContext } from '../../client/testing.ts';
import { repoModules } from '../repo.ts';

// Every module in the checkout, so a command any of them brings is held to the rule. A core test
// rather than the assistant's: it is the assistant's reason, but the rule binds every module.
const testCtx = createTestContext({ modules: repoModules().map((module) => module.name) });

Deno.test({ name: 'command-effects', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  try {
    const specs: CmdSpec[] = [];
    const path = `${(await client.exec('echo $PATH')).data}`.trim();
    for (const dir of [...new Set(path.split(':').filter(Boolean))]) {
      const listing = await client.execJson<{ name: string }[] | string[]>(`ls ${dir}`).catch(() => []);
      for (const entry of listing) specs.push(await client.execJson<CmdSpec>(`${typeof entry === 'string' ? entry : entry.name} --help`));
    }

    await t.step('every command declares its effect', () => {
      assertEquals(specs.filter((spec) => spec.effect !== 'read' && spec.effect !== 'write' && !spec.group).map((spec) => spec.name), []);
    });

    await t.step('every flag says whether it takes a value, which the judge reads the line by', () => {
      const types = new Set(['bool', 'string', 'number', 'path', 'user', 'group', 'command', 'subcommand']);
      assertEquals(specs.flatMap((spec) => (spec.flags ?? []).filter((flag) => !types.has(flag.type ?? '')).map((flag) => `${spec.name} --${flag.name}`)), []);
    });

    await t.step('a flag that makes a command report instead of change says so', () => {
      const unmarked = specs.flatMap((spec) =>
        (spec.flags ?? []).filter((flag) => (flag.name === 'dry-run' || /^dry run/i.test(flag.description)) && !flag.dryRun).map((flag) => `${spec.name} --${flag.name}`)
      );
      assertEquals(unmarked, []);
    });

    await t.step('a daemon is an administrator command', () => {
      assertEquals(specs.filter((spec) => spec.daemon && !spec.admin).map((spec) => spec.name), []);
    });

    await t.step('real lines are judged by the real specs', async () => {
      const byName = new Map(specs.map((spec) => [spec.name, spec]));
      const judged = async (line: string) => (await judgeLine(line, (name) => byName.get(name))).effect;
      const cases: [string, 'read' | 'write'][] = [
        ['service-list', 'read'],
        ['service status pipeline-pruner', 'read'],
        ['service restart pipeline-pruner', 'write'],
        ['www list', 'read'],
        ['www set classic', 'write'],
        ['attrs /archive/people/Anna_Exempel', 'read'],
        ["attrs -s 'name=Anna' /archive/people/Anna_Exempel", 'write'],
        ['df | jq .tiers', 'read'],
        ['ls /archive > /home/admin/list.txt', 'write'],
      ];
      for (const [line, effect] of cases) assertEquals(await judged(line), effect, line);
    });

    await t.step('what makes a reading command write is only declared on one', () => {
      const misplaced = specs.filter((spec) => spec.effect === 'write' && [...(spec.flags ?? []), ...(spec.args ?? [])].some((def) => def.writes)).map((spec) => spec.name);
      assertEquals(misplaced, []);
    });
  } finally {
    await testCtx.teardown();
  }
});
