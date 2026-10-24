import { assertEquals } from '@std/assert';
import { judgeLine } from '../effect.ts';
import type { CmdSpec } from '../types.ts';
import { xargs } from '../commands/utils/xargs.ts';

const SPECS: Record<string, CmdSpec> = {
  ls: { name: 'ls', effect: 'read', flags: [{ name: 'l', type: 'bool', description: 'long' }] },
  stat: { name: 'stat', effect: 'read' },
  jq: { name: 'jq', effect: 'read' },
  'service-list': { name: 'service-list', effect: 'read' },
  attrs: {
    name: 'attrs',
    effect: 'read',
    args: [{ name: 'path', type: 'path', description: 'node' }],
    flags: [
      { name: 'L', type: 'bool', description: 'no follow' },
      { name: 's', type: 'string', description: 'set', writes: true },
      { name: 'd', type: 'string', description: 'unset', writes: true },
    ],
  },
  config: {
    name: 'config',
    effect: 'read',
    args: [{ name: 'key', type: 'string', description: 'key' }, { name: 'value', type: 'string', description: 'value to set', writes: true }],
    flags: [{ name: 'format', type: 'string', description: 'output format' }],
  },
  rm: { name: 'rm', effect: 'write' },
  album: {
    name: 'album',
    effect: 'read',
    args: [{ name: 'subcommand', type: 'string', description: 'create | info', writes: ['create', 'set'] }, { name: 'path', type: 'path', description: 'album' }],
    flags: [{ name: 'limit', type: 'string', description: 'page' }],
  },
  'person-fixup': { name: 'person-fixup', effect: 'write', flags: [{ name: 'dry-run', type: 'bool', description: 'report', dryRun: true }] },
  'media-scan': { name: 'media-scan', effect: 'write', flags: [{ name: 'n', type: 'bool', description: 'report', dryRun: true }] },
  unclassified: { name: 'unclassified' },
  service: { name: 'service', group: true },
  'service-status': { name: 'service-status', effect: 'read' },
  'service-stop': { name: 'service-stop', effect: 'write' },
  find: {
    name: 'find',
    effect: 'read',
    flags: [{ name: 'name', type: 'string', description: 'glob' }],
    words: [{ word: '-delete', writes: true }, { word: '-exec', runs: [';', '+'] }],
  },
  xargs: xargs.spec,
};
const specOf = (name: string) => SPECS[name];
const effect = async (line: string) => (await judgeLine(line, specOf)).effect;

Deno.test('a line of reads is a read, however it is put together', async () => {
  for (
    const line of [
      'ls -l /archive',
      'ls /a | jq .',
      'stat /a && ls /b; service-list',
      'echo $(service-list) | jq .',
      'for x in /a /b; do stat $x; done',
      'JSON_OUTPUT=1 ls /a 2>&1',
      'ls /a > /dev/null',
      'X=1',
      'rm --help',
      'service status pipeline-pruner',
    ]
  ) assertEquals(await effect(line), 'read', line);
});

Deno.test('a write anywhere in the line makes it a write, with the reason', async () => {
  assertEquals(await judgeLine('ls /a && rm /a/b', specOf), { effect: 'write', reasons: ['rm changes something'] });
  assertEquals((await judgeLine('echo $(rm /x)', specOf)).effect, 'write');
  assertEquals((await judgeLine('for x in a; do rm $x; done', specOf)).effect, 'write');
  assertEquals((await judgeLine('service stop pipeline-pruner', specOf)).reasons, ['service-stop changes something']);
});

Deno.test('a reading command is a write with a flag or argument that writes', async () => {
  assertEquals(await effect('attrs /a'), 'read');
  assertEquals(await effect('attrs -L /a'), 'read');
  assertEquals((await judgeLine("attrs -s 'name=Anna Exempel' /a", specOf)).reasons, ['attrs -s changes something']);
  assertEquals(await effect('attrs -Ls x=1 /a'), 'write');
  // A flag the spec does not list may be an alias of one that writes.
  assertEquals((await judgeLine('attrs --set x=1 /a', specOf)).reasons, ['attrs --set is not in its spec']);
  // …but a command with no writing flag cannot be made to write by one.
  assertEquals(await effect('ls --all /a'), 'read');
  assertEquals(await effect('config db.host'), 'read');
  assertEquals(await effect('config --format json db.host'), 'read');
  assertEquals((await judgeLine('config db.host localhost', specOf)).reasons, ['config with value changes something']);
});

Deno.test('a redirection into a file writes, a descriptor or /dev/null does not', async () => {
  assertEquals((await judgeLine('ls /a > /home/anna/list.txt', specOf)).reasons, ['> /home/anna/list.txt writes a file']);
  assertEquals(await effect('ls /a >> /x'), 'write');
  assertEquals(await effect('ls /a >& /x'), 'write');
  assertEquals(await effect('{ ls /a; } > /x'), 'write');
  assertEquals(await effect('for x in a; do ls $x; done > /x'), 'write');
  assertEquals(await effect('ls /a 2>&1 >&-'), 'read');
});

Deno.test('help is a read only as the first word, where it stops the command', async () => {
  assertEquals(await effect('service status --help'), 'read');
  assertEquals(await effect('rm -h'), 'read');
  assertEquals((await judgeLine('rm -r /a --help', specOf)).reasons, ['rm changes something']);
});

Deno.test('an expression word writes wherever it stands, and the command -exec runs is judged as one', async () => {
  assertEquals(await effect("find /a -name '*.jpg'"), 'read');
  assertEquals(await effect("find /a -name '*.jpg' -exec stat {} ';' -print"), 'read');
  assertEquals((await judgeLine("find /a -name '*.tmp' -delete", specOf)).reasons, ['find -delete changes something']);
  assertEquals((await judgeLine('find /a -exec rm -r {} + -print', specOf)).reasons, ['rm changes something']);
  assertEquals((await judgeLine("find /a -exec ls {} ';' -exec attrs -s x=1 {} ';'", specOf)).reasons, ['attrs -s changes something']);
  assertEquals((await judgeLine("find /a -exec find {} -delete ';'", specOf)).reasons, ['find -delete changes something']);
  assertEquals((await judgeLine("find /a -exec {} ';'", specOf)).reasons, ['{} is not a known command']);
  // An -exec left open takes the rest of the line, which find refuses: -delete there is ls's argument.
  assertEquals(await effect('find /a -exec ls {} -delete'), 'read');
  assertEquals(await effect('find /a -exec rm {}'), 'write');
});

Deno.test('the command xargs runs is judged as one, from its first word to the end of the line', async () => {
  for (
    const line of [
      'xargs',
      'ls /a | xargs stat',
      'xargs -0 ls -l',
      'xargs -n 2 -I {} stat {}',
      'xargs -rtn2 -I{} ls {} -l',
      'xargs --max-args=2 --null stat',
      'xargs --replace {} stat {}',
      'xargs -- ls -l',
    ]
  ) assertEquals(await effect(line), 'read', line);
  assertEquals((await judgeLine('find /a | xargs rm', specOf)).reasons, ['rm changes something']);
  assertEquals((await judgeLine('xargs -0 -I {} attrs -s x=1 {}', specOf)).reasons, ['attrs -s changes something']);
  assertEquals((await judgeLine('xargs -d , -- find -delete', specOf)).reasons, ['find -delete changes something']);
  // A flag's value is not the command: -I takes the word after it.
  assertEquals((await judgeLine('xargs -I ls rm', specOf)).reasons, ['rm changes something']);
  assertEquals(await effect('xargs -I rm stat rm'), 'read');
  assertEquals((await judgeLine('xargs --max-lines rm stat', specOf)).effect, 'read');
  assertEquals((await judgeLine('xargs -n2 rm', specOf)).reasons, ['rm changes something']);
});

Deno.test('what the judge cannot vouch for is a write', async () => {
  assertEquals((await judgeLine('nosuch /a', specOf)).reasons, ['nosuch is not a known command']);
  assertEquals((await judgeLine('unclassified', specOf)).reasons, ['unclassified does not say whether it changes anything']);
  assertEquals((await judgeLine('service frobnicate', specOf)).reasons, ['service frobnicate is not a known subcommand']);
  assertEquals((await judgeLine('$CMD /a', specOf)).reasons, ['the command is named by an expansion']);
  assertEquals(await effect('eval "rm /a"'), 'write');
  assertEquals(await effect('f() { ls; }'), 'write');
  assertEquals((await judgeLine('ls "unclosed', specOf)).effect, 'write');
});

Deno.test('a subcommand writes only with the values that do; a dry run of a write is a read', async () => {
  assertEquals(await effect('album info /archive/albums/A'), 'read');
  assertEquals(await effect('album --limit 10 info /a'), 'read');
  assertEquals((await judgeLine('album create /archive/albums/B', specOf)).reasons, ['album create changes something']);
  assertEquals(await effect('person-fixup'), 'write');
  assertEquals(await effect('person-fixup --dry-run'), 'read');
  assertEquals(await effect('media-scan -n /archive'), 'read');
  // A dry run does not excuse a redirection.
  assertEquals(await effect('person-fixup --dry-run > /x'), 'write');
});
