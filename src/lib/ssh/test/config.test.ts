/**
 * Which `~/.ssh/config` settings apply to a host.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { createMemoryTestVfs } from '../../../testing/memory-vfs.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { matchPatternList, readSshConfig } from '../config.ts';
import { writeText } from '../files.ts';

Deno.test('ssh_config: pattern lists', () => {
  assertEquals(matchPatternList('nas.local', ['*.local']), true);
  assertEquals(matchPatternList('NAS.local', ['nas.local']), true);
  assertEquals(matchPatternList('nas.local', ['*.local', '!nas.local']), false);
  assertEquals(matchPatternList('backup.local', ['*.local,!nas.local']), true);
  assertEquals(matchPatternList('nas', ['n?s']), true);
  assertEquals(matchPatternList('nas', ['!other']), false);
});

Deno.test('ssh_config: the settings for a host', async (t) => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const { vfs } = await createMemoryTestVfs(routerManager);
  const home = '/home';
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'home');
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, home, '.ssh');
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, `${home}/.ssh`, 'config.d');
  const write = (name: string, text: string) => writeText(vfs, ADMIN_ACCESS, `${home}/.ssh/${name}`, text, 0o600);
  const read = (host: string, user?: string) =>
    readSshConfig(vfs, ADMIN_ACCESS, home, `${home}/.ssh/config`, { host, user, localUser: 'anna' }).then((m) => Object.fromEntries(m));

  await write(
    'config',
    [
      '# boats',
      'Host nas',
      '  HostName nas.example.com',
      '  Port=2222',
      '  IdentityFile "~/.ssh/my key"   # quoted, with a space',
      '',
      'Host *.example.com !skip.example.com',
      '  User boatman',
      '',
      'Match user backup',
      '  ConnectTimeout 3',
      '',
      'Match host nas.example.com',
      '  ServerAliveInterval 30',
      '',
      'Match exec "true"',
      '  BatchMode yes',
      '',
      'Host *',
      '  Port 22',
      '  Include config.d/*',
    ].join('\n'),
  );
  await write('config.d/a', 'StrictHostKeyChecking accept-new\n');

  await t.step('the first value for a keyword wins; Match host sees HostName', async () => {
    assertEquals(await read('nas'), {
      hostname: 'nas.example.com',
      port: '2222',
      identityfile: '~/.ssh/my key',
      serveraliveinterval: '30',
      stricthostkeychecking: 'accept-new',
    });
  });

  await t.step('patterns, negation and Match user', async () => {
    assertEquals(await read('sea.example.com', 'backup'), {
      user: 'boatman',
      connecttimeout: '3',
      port: '22',
      stricthostkeychecking: 'accept-new',
    });
    assertEquals(await read('skip.example.com'), { port: '22', stricthostkeychecking: 'accept-new' });
  });

  await t.step('a missing file gives nothing', async () => {
    assertEquals(
      Object.fromEntries(await readSshConfig(vfs, ADMIN_ACCESS, home, `${home}/.ssh/none`, { host: 'nas', localUser: 'anna' })),
      {},
    );
  });
});
