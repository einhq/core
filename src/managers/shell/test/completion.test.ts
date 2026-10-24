/**
 * Tab completion: the generators print candidate words, which the executor's
 * completion — readline's, as bash sets it up — puts in the line. And globs,
 * which `compgen -f` is built on, answer in the form the pattern was written in.
 */

import { assertEquals } from '@std/assert';
import type { TabCompletion } from '@ein/bash-executor';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { InteractiveShell } from '../interactive-shell.ts';

/** A Tab at the end of `line` in `shell`, or the Tab that lists. */
const tabber = (shell: InteractiveShell) => {
  const onTab = (shell as unknown as { onTab(line: string, point: number, list: boolean): Promise<TabCompletion> }).onTab.bind(shell);

  return {
    tab: async (line: string) => (await onTab(line, line.length, false)).line,
    list: async (line: string) => (await onTab(line, line.length, true)).list,
  };
};

Deno.test({
  name: 'completion generators',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const harness = new SystemTestHarness({ ssh: false, boot: true });
  const { vfs, cem, bufferManager } = await harness.startPrimary();
  const client = await harness.createShellClient();

  await client.exec('mkdir -p /opt/tree/alpha /opt/tree/beta && echo x > /opt/tree/apple');

  await t.step('a relative glob expands to relative paths', async () => {
    assertEquals((await client.execString('cd /opt/tree && echo a*')).trim(), 'alpha apple');
    assertEquals((await client.execString('cd /opt/tree/alpha && echo ../b*')).trim(), '../beta');
    assertEquals((await client.execString('cd /opt && echo ./tree/a*')).trim(), './tree/alpha ./tree/apple');
    assertEquals((await client.execString('echo /opt/tree/b*')).trim(), '/opt/tree/beta');
  });

  await t.step('completion-path marks directories, and any node whose whole name is typed', async () => {
    assertEquals(await client.execString('cd /opt/tree && completion-path --word=a'), 'alpha/\napple\n');
    assertEquals(await client.execString('cd /opt/tree && completion-path --word=apple'), 'apple/\n');
    assertEquals(await client.execString('completion-path --word=/opt/tree/b'), '/opt/tree/beta/\n');
    assertEquals(await client.execString('cd /opt/tree/alpha && completion-path --word=..'), '../alpha/\n../beta/\n../apple\n');
  });

  await t.step('completion-arg fills a typed flag and its value', async () => {
    assertEquals(await client.execString('completion-arg mknode --word=--un'), '--under=\n');
    assertEquals(await client.execString('cd /opt/tree && completion-arg ls --word=b'), 'beta/\n');
  });

  await t.step('completion-arg asks a script on PATH for the spec it declares', async () => {
    const script = async (name: string, source: string) => {
      await vfs.ensure(ADMIN_ACCESS, 'file', '/opt/bin', name, { attrs: { mimetype: 'text/x-shellscript' } });
      const handle = await vfs.open(ADMIN_ACCESS, `/opt/bin/${name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(source));
      } finally {
        await handle.close();
      }
    };
    await client.exec('mkdir -p /opt/bin');
    await script('mkthing', '#!bash\n# Makes a thing\narg --desc "Make a thing"\narg \'<target>\' path "Where"\narg --owner user "Who owns it"\narg --export\necho made\n');
    await script('thing', '#!bash\narg --desc "Things"\narg --group\narg \'<subcommand>\' string "make or list"\narg --rest\narg --export\nthing-$SUBCOMMAND "$@"\n');
    await script('thing-make', '#!bash\narg \'<target>\' path "Where"\narg --export\n');
    await script('thing-list', '#!bash\narg --export\n');
    await script('passon', '#!bash\narg --desc "Hands everything on"\narg --rest\narg --export\nls "$@"\n');
    await script('plain', '#!bash\nmkdir /opt/plain-ran\n');
    const at = 'export PATH=/opt/bin:/usr/bin && cd /opt/tree &&';

    assertEquals(await client.execString(`${at} completion-arg mkthing --word=b`), 'beta/\n');
    assertEquals(await client.execString(`${at} completion-arg mkthing --word=--ow`), '--owner=\n');
    // A group script routes to its subcommand, whose spec is asked in turn
    assertEquals(await client.execString(`${at} completion-arg thing --word=m`), 'make\n');
    assertEquals(await client.execString(`${at} completion-arg thing make --word=b`), 'beta/\n');
    // What a script hands on is not in its spec, and a script with no spec is not asked: paths
    assertEquals(await client.execString(`${at} completion-arg passon --word=b`), 'beta/\n');
    assertEquals(await client.execString(`${at} completion-arg plain --word=b`), 'beta/\n');
    assertEquals(await vfs.exists(ADMIN_ACCESS, '/opt/plain-ran'), false);
  });

  await t.step('compgen -c offers builtins and functions next to PATH', async () => {
    const words = (await client.execString('myfn() { :; }; compgen -c -- my; compgen -c -- expor; compgen -c -- mkno')).split('\n');
    assertEquals(words.filter(Boolean), ['myfn', 'export', 'mknode']);
  });

  await t.step('a Tab on a command name hides group subcommands and offers builtins', async () => {
    const { sessionPath } = await harness.createHttpSession();
    const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();
    // A shell made here starts without /usr/bin on its PATH
    await shell.run('export PATH=/usr/bin:/usr/lib/core/bin');
    const { tab, list } = tabber(shell);

    try {
      // `completion` is a group: `completion-arg` and the rest are reached as `completion arg`
      assertEquals(await tab('completio'), 'completion ');
      assertEquals(await list('completio'), ['completion']);
      assertEquals(await tab('unali'), 'unalias ');
      assertEquals(await tab('completion pa'), 'completion path ');
      // A group's subcommand typed out is still completed, by bash's own command completion
      assertEquals(await tab('completion-pa'), 'completion-path ');
    } finally {
      await shell.close();
    }
  });

  await t.step("a Tab on an argument is bash's programmable completion, the command's spec by default", async () => {
    const { sessionPath } = await harness.createHttpSession();
    const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();
    await shell.run('export PATH=/usr/bin:/usr/lib/core/bin');
    const { tab, list } = tabber(shell);

    try {
      // _ein_complete, the -D default, asks completion-arg: a flag awaiting its value, a directory
      assertEquals((await shell.runAndCapture('complete -p -D')).stdout, 'complete -F _ein_complete -D\n');
      assertEquals(await tab('mknode --un'), 'mknode --under=');
      await shell.run('cd /opt/tree');
      assertEquals(await tab('ls b'), 'ls beta/');
      assertEquals(await tab('echo x; ls b'), 'echo x; ls beta/');
      // Paths are listed by their last part
      assertEquals(await list('ls /opt/tree/a'), ['alpha/', 'apple']);

      // Builtins that take names complete the names
      await shell.run('ein_completion_var=1');
      assertEquals(await tab('unset ein_completion_v'), 'unset ein_completion_var ');
      assertEquals(await tab('shopt -s extgl'), 'shopt -s extglob ');
      assertEquals(await tab('type mkno'), 'type mknode ');

      // A completion of the user's own, as .bashrc would define it, with its options
      await shell.run('_pets() { COMPREPLY=($(compgen -W "cat dog cow" -- "$2")); }; complete -o nospace -F _pets pet');
      assertEquals(await tab('pet d'), 'pet dog');
      assertEquals(await tab('pet c'), 'pet c');
      assertEquals(await list('pet c'), ['cat', 'cow']);
    } finally {
      await shell.close();
    }
  });
});
