import { assertEquals } from '@std/assert';
import { History, LineEditor, type TabCompletion } from '@ein/bash-executor';
import { BufferManager } from '../../../buffer/mod.ts';
import { Readline } from '../readline.ts';

Deno.test('readline Tab', async (t) => {
  const bufferManager = new BufferManager();
  await bufferManager.init();
  const encoder = new TextEncoder();

  /** A prompt with these keys typed, the Tabs answered by `onTab`; the line, and what was drawn. */
  const promptWith = async (id: string, typed: string, onTab: (line: string, point: number, list: boolean) => TabCompletion) => {
    await bufferManager.touch(`${id}-in`, {});
    await bufferManager.touch(`${id}-out`, {});
    const stdin = await bufferManager.open(`${id}-in`, {}, 'r+');
    const stdout = await bufferManager.open(`${id}-out`, {}, 'r+');
    const rl = new Readline({ in: stdin, out: stdout, rows: 10, cols: 20, onTab: async (line, point, list) => await onTab(line, point, list) });
    const line = rl.prompt('$ ');

    stdin.write(encoder.encode(typed));

    const result = await line;
    const out = await bufferManager.open(`${id}-out`, {}, 'r');
    const drawn = new TextDecoder().decode(await out.read(10000));

    return { line: result, drawn };
  };

  await t.step('the line and the cursor are as the completion leaves them', async () => {
    const asked: [string, number, boolean][] = [];
    const { line } = await promptWith('mid', 'group-me users\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\tX\r', (line, point, list) => {
      asked.push([line, point, list]);
      return { line: 'group-members users', point: 13, bell: false };
    });

    assertEquals(asked, [['group-me users', 8, false]]);
    assertEquals(line, 'group-membersX users');
  });

  await t.step('the Tab after one that changed nothing lists the matches, in columns', async () => {
    const asked: boolean[] = [];
    const { line, drawn } = await promptWith('list', 'ls s\t\t\r', (line, point, list) => {
      asked.push(list);
      return list ? { line, point, list: ['src/', 'srv/', 'sys/'], widest: 3, bell: false } : { line, point, bell: true };
    });

    assertEquals(asked, [false, true]);
    assertEquals(line, 'ls s');
    // Under the line, as wide as the widest name and two spaces, its `/` not counted
    assertEquals(drawn.includes('$ ls s\r\x1b[6C\r\nsrc/ srv/ sys/\r\n'), true);
  });
});

Deno.test('readline keys over the shell history', async (t) => {
  const bufferManager = new BufferManager();
  await bufferManager.init();
  const encoder = new TextEncoder();
  const history = new History();
  const editor = new LineEditor(() => history);

  for (const line of ['echo one', 'echo two', 'echo three']) history.add(line);

  /** A prompt on the shell's one editor, as each of the shell's prompts is */
  const promptWith = async (id: string, typed: string) => {
    await bufferManager.touch(`${id}-in`, {});
    await bufferManager.touch(`${id}-out`, {});
    const stdin = await bufferManager.open(`${id}-in`, {}, 'r+');
    const stdout = await bufferManager.open(`${id}-out`, {}, 'r+');
    const rl = new Readline({ in: stdin, out: stdout, rows: 10, cols: 100, editor });
    const line = rl.prompt('$ ');

    if (typed) stdin.write(encoder.encode(typed));

    return await line;
  };

  await t.step('C-r finds a line, C-o runs it and brings back the next at the next prompt', async () => {
    assertEquals(await promptWith('search', '\x12two\x0f'), 'echo two');
    history.add('echo two');
    assertEquals(await promptWith('next', '\r'), 'echo three');
  });

  await t.step('lines typed ahead wait for their prompts', async () => {
    assertEquals(await promptWith('ahead', 'echo a\recho b\r'), 'echo a');
    assertEquals(await promptWith('ahead2', ''), 'echo b');
  });
});
