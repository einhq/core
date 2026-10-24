/**
 * `ssh-copy-id`: install your public key in `~/.ssh/authorized_keys` on
 * another machine, so later `ssh`/`scp` log in with the key. Works over SFTP
 * rather than a remote shell pipeline, so it does not depend on the remote
 * shell; a key already there is not added twice.
 */

import { resolve } from '@std/path';
import { toText } from '@std/streams';
import type { Client } from 'ssh2';
import { connectSsh, DEFAULT_IDENTITIES, formatTarget, parseSshTarget, readText, sftpKind, sftpReadable, SshConnectError, sshDir } from '../../../../lib/ssh/mod.ts';
import type { SshCopyIdResult } from '../../../../lib/api/ssh.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { applySshOption, checkSshAllowed, connectOptions, hostSettings, parsePort, type SshConfigOptions, sshUserFromCommand } from './options.ts';

interface CopyIdArgs {
  config: SshConfigOptions;
  identity?: string;
  force: boolean;
  dryRun: boolean;
  host: string;
}

function parseCopyIdArgs(args: string[]): CopyIdArgs {
  const config: SshConfigOptions = {};
  let identity: string | undefined;
  let force = false;
  let dryRun = false;
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      if (host) throw new Error(`unexpected argument '${arg}'`);
      host = arg;
      continue;
    }
    const letter = arg[1];
    const attached = arg.length > 2 ? arg.slice(2) : undefined;
    const value = () => {
      const v = attached ?? args[++i];
      if (v === undefined) throw new Error(`option requires an argument -- ${letter}`);
      return v;
    };
    if (letter === 'i') identity = value();
    else if (letter === 'p') config.port = parsePort(value());
    else if (letter === 'o') applySshOption(config, value());
    else if (letter === 'f') force = true;
    else if (letter === 'n') dryRun = true;
    else throw new Error(`unknown option -- ${letter}`);
  }

  if (!host) throw new Error('missing host');
  return { config, identity, force, dryRun, host };
}

/** The `type base64` part of an authorized_keys or .pub line, options and comment ignored */
function keyIdentity(line: string): string | undefined {
  const m = line.match(/(?:^|\s)((?:ssh-|ecdsa-|sk-)[\w@.-]+)\s+([A-Za-z0-9+/=]+)/);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

export const sshCopyId = async (cmd: Command): CmdReturn => {
  let args: CopyIdArgs;
  try {
    args = parseCopyIdArgs(cmd.args);
  } catch (error) {
    await cmd.writeError(`ssh-copy-id: ${(error as Error).message}\nusage: ssh-copy-id [-f] [-n] [-i identity.pub] [-p port] [-o option] [user@]host\n`);
    return 1;
  }

  if (!await checkSshAllowed(cmd, 'ssh-copy-id')) return 1;

  let target;
  try {
    target = parseSshTarget(args.host);
  } catch (error) {
    await cmd.writeError(`ssh-copy-id: ${(error as Error).message}\n`);
    return 1;
  }

  // The public key: -i names it (with or without .pub), else the first default one
  const vfs = cmd.sys.vfs;
  const candidates = args.identity
    ? [resolve(cmd.cwd, args.identity.endsWith('.pub') ? args.identity : `${args.identity}.pub`)]
    : DEFAULT_IDENTITIES.map((name) => `${sshDir(cmd.env.HOME)}/${name}.pub`);

  let pubPath: string | undefined;
  let pubLine: string | undefined;
  for (const path of candidates) {
    const text = await readText(vfs, cmd.access, path);
    if (text !== undefined && keyIdentity(text)) {
      pubPath = path;
      pubLine = text.trim().split('\n')[0];
      break;
    }
  }
  if (!pubPath || !pubLine) {
    await cmd.writeError(
      args.identity ? `ssh-copy-id: ${candidates[0]}: no public key there\n` : 'ssh-copy-id: no public key found in ~/.ssh; make one with ssh-keygen\n',
    );
    return 1;
  }

  await cmd.writeError(`ssh-copy-id: INFO: Source of key(s) to be installed: "${pubPath}"\n`);

  let config: SshConfigOptions;
  try {
    config = await hostSettings(cmd, target.host, { ...args.config, user: target.user ?? args.config.user });
  } catch (error) {
    await cmd.writeError(`ssh-copy-id: ${(error as Error).message}\n`);
    return 1;
  }
  const abort = new AbortController();
  cmd.onInterrupt(() => abort.abort());

  let client: Client | undefined;
  try {
    // The key is not installed yet, so this is usually a password login
    client = await connectSsh(sshUserFromCommand(cmd), connectOptions(target.host, config, abort.signal));
    const sftp = await client.sftp();

    const dotSsh = '.ssh';
    const authorized = `${dotSsh}/authorized_keys`;

    const dirStats = await sftp.stat(dotSsh).catch(() => undefined);
    if (dirStats && sftpKind(dirStats) !== 'directory') {
      await cmd.writeError('ssh-copy-id: ~/.ssh on the remote side is not a directory\n');
      return 1;
    }

    // What is there already
    let existing = '';
    const fileStats = await sftp.stat(authorized).catch(() => undefined);
    if (fileStats) {
      const handle = await sftp.open(authorized, 'r');
      try {
        existing = await toText(sftpReadable(sftp, handle));
      } finally {
        await sftp.close(handle).catch(() => {});
      }
    }

    const wanted = keyIdentity(pubLine)!;
    const present = existing.split('\n').some((line) => keyIdentity(line) === wanted);
    if (present && !args.force) {
      await cmd.writeError('ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n');
      if (cmd.json) await cmd.writeJSON({ ok: true, added: 0 } satisfies SshCopyIdResult);
      return 0;
    }

    if (args.dryRun) {
      await cmd.write(`=-=-=-=-=-=-=-=\nWould have added the following key(s):\n\n${pubLine}\n=-=-=-=-=-=-=-=\n`);
      return 0;
    }

    if (!dirStats) await sftp.mkdir(dotSsh, { mode: 0o700 });

    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    const bytes = new TextEncoder().encode(`${sep}${pubLine}\n`);
    const handle = await sftp.open(authorized, 'a', { mode: 0o600 });
    try {
      // At the end, for a server that does not honour the append flag
      await sftp.write(handle, bytes, 0, bytes.length, Number(fileStats?.size ?? 0));
    } finally {
      await sftp.close(handle).catch(() => {});
    }
    // sshd refuses keys in a file others may write
    if (!fileStats) await sftp.chmod(authorized, 0o600).catch(() => {});

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, added: 1 } satisfies SshCopyIdResult);
    } else {
      const who = formatTarget({ ...target, user: config.user ?? cmd.env.USER });
      const port = config.port && config.port !== 22 ? ` -p ${config.port}` : '';
      await cmd.write(
        `\nNumber of key(s) added: 1\n\nNow try logging into the machine, with:   "ssh${port} '${who}'"\n` +
          'and check to make sure that only the key(s) you wanted were added.\n\n',
      );
    }
    return 0;
  } catch (error) {
    if (abort.signal.aborted) return 130;
    const message = error instanceof SshConnectError ? error.message : (error as Error).message;
    await cmd.writeError(`ssh-copy-id: ${message}\n`);
    return 1;
  } finally {
    cmd.onInterrupt(null);
    client?.end();
  }
};

sshCopyId.spec = {
  name: 'ssh-copy-id',
  effect: 'write' as const,
  description: "Install your public key in another machine's authorized_keys (members of group ssh)",
  args: [
    { name: 'destination', type: 'string' as const, description: '[user@]host' },
  ],
  flags: [
    { name: 'i', type: 'path' as const, description: 'public key file (default: first of ~/.ssh/id_ed25519.pub, id_ecdsa.pub, id_rsa.pub)' },
    { name: 'p', type: 'number' as const, description: 'port (default 22)' },
    { name: 'o', type: 'string' as const, repeatable: true, description: 'ssh option, e.g. StrictHostKeyChecking=accept-new' },
    { name: 'f', type: 'bool' as const, description: 'add the key even if it is already there' },
    { name: 'n', type: 'bool' as const, description: 'only show what would be added', dryRun: true },
  ],
  examples: [
    'ssh-copy-id anna@nas.local',
    'ssh-copy-id -i ~/.ssh/id_rsa.pub -p 2222 anna@backup.example.com',
  ],
  returns: 'nothing; JSON mode: { ok, added }.',
};
