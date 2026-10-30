import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { generateKeyPair } from 'ssh2';
import { parseArgs } from '../../../lib/args/mod.ts';
import { ResourceHandleIf } from '../../../registries/types.ts';
import { SSHServer } from '../../../servers/ssh/mod.ts';
import { NodeNotFoundError } from '../../../vfs/mod.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import type { Command } from '../command.ts';
import { CmdReturn } from '../types.ts';

const writeFile = async (cmd: Command, path: string, data: string, mimetype: string, mode: number): Promise<void> => {
  // Every file node carries name/mimetype/size; the size follows the write.
  await cmd.sys.vfs.ensure<FileAttrs>(cmd.access, NODE_TYPE_FILE, dirname(path), basename(path), {
    props: { mode, tier: 'db' },
    attrs: { name: basename(path), mimetype, size: 0 },
  });

  const rh = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });

  try {
    await rh.write(new TextEncoder().encode(data));
  } finally {
    await rh.close();
  }
};

export const sshServer = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['port'],
  });
  const port = Number.parseInt(flags.port || '2222', 10);
  const keyPath = join(cmd.env.ETC_PATH, 'ssh_host_key');

  if (!(await cmd.sys.vfs.exists(cmd.access, keyPath))) {
    await cmd.writeLn('no host key found, generating pair...');

    const kp = await generateKeyPair('ed25519');

    try {
      await writeFile(cmd, keyPath, kp.private, 'application/x-pem-file', 0o600);
      await writeFile(cmd, keyPath + '.pub', kp.public, 'text/plain', 0o644);
    } catch (err) {
      await cmd.writeError(`ssh-server: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let key = '';
  let keyHandle: ResourceHandleIf | undefined;
  try {
    keyHandle = await cmd.sys.vfs.open(cmd.access, keyPath, { mode: 'r' });
    key = await toText(keyHandle.readable);
  } catch (err) {
    if (err instanceof NodeNotFoundError) {
      await cmd.writeError(`ssh-server: no host key found: ${keyPath}\n`);
    } else {
      await cmd.writeError(`ssh-server: error opening key: ${(err as Error).message}\n`);
    }

    return 1;
  } finally {
    keyHandle && (await keyHandle.close());
  }

  try {
    const sshServer = new SSHServer({
      port: port,
      hostKey: key,
      cem: cmd.sys.cem,
      vfs: cmd.sys.vfs,
      bufferManager: cmd.sys.bufferManager,
      env: cmd.env,
    });

    await sshServer.start();

    await cmd.writeLn(`SSH server ready on port ${port}`);
    await cmd.writeLn(`Connect with: ssh -p ${port} user@localhost`);
    await cmd.writeLn(`Mount with: sshfs -p ${port} user@localhost:/ /mnt/vfs`);

    await new Promise<void>((resolve) => {
      cmd.onInterrupt(() => {
        cmd.writeError(`ssh-server: exiting...`).catch(() => {});
        sshServer.stop();
        resolve();
      });
    });
  } catch (err) {
    await cmd.writeError(`ssh-server: ${(err as Error).message}`);
    return 1;
  }

  return 0;
};

sshServer.spec = {
  name: 'ssh-server',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Start an SSH server',
  args: [],
  flags: [
    {
      name: 'port',
      type: 'string' as const,
      description: 'port to use',
    },
  ],
};
