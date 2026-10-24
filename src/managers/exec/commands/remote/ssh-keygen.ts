/**
 * `ssh-keygen`: make a key pair for `ssh`/`scp` in `~/.ssh`, show a key's
 * fingerprint (`-l`), or forget a host's key (`-R`).
 */

import { encodeBase64 } from '@std/encoding';
import { resolve } from '@std/path';
import { generateKeyPair, parseKey } from 'ssh2';
import { ensureSshDir, fingerprint, readText, removeHost, sshDir, writeText } from '../../../../lib/ssh/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { SshKeyFingerprint, SshKeyPairCreated } from '../../../../lib/api/ssh.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const TYPES: Record<string, { file: string; bits?: number; label: string }> = {
  ed25519: { file: 'id_ed25519', label: 'ED25519' },
  ecdsa: { file: 'id_ecdsa', bits: 256, label: 'ECDSA' },
  rsa: { file: 'id_rsa', bits: 3072, label: 'RSA' },
};

const KEY_BITS: Record<string, number> = { 'ssh-ed25519': 256, 'ecdsa-sha2-nistp256': 256, 'ecdsa-sha2-nistp384': 384, 'ecdsa-sha2-nistp521': 521 };
const KEY_LABELS: Record<string, string> = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA' };

/** An RSA public blob is string type, mpint e, mpint n: the size is n's */
function rsaBits(blob: Uint8Array): number {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let p = 4 + view.getUint32(0); // type
  p += 4 + view.getUint32(p); // e
  const len = view.getUint32(p);
  let n = blob.subarray(p + 4, p + 4 + len);
  while (n.length && n[0] === 0) n = n.subarray(1);
  return n.length ? (n.length - 1) * 8 + (32 - Math.clz32(n[0])) : 0;
}

async function showFingerprint(cmd: Command, path: string): Promise<number> {
  const text = await readText(cmd.sys.vfs, cmd.access, path) ??
    await readText(cmd.sys.vfs, cmd.access, `${path}.pub`);
  if (text === undefined) {
    await cmd.writeError(`ssh-keygen: ${path}: No such file or directory\n`);
    return 1;
  }

  // A private key file may be encrypted; its .pub, or a public key, is enough
  const pubText = text.includes('PRIVATE KEY') ? await readText(cmd.sys.vfs, cmd.access, `${path}.pub`) ?? text : text;
  const parsed = parseKey(pubText);
  if (parsed instanceof Error) {
    await cmd.writeError(`ssh-keygen: ${path} is not a key file.\n`);
    return 1;
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  const blob = key.getPublicSSH();
  if (!blob) {
    await cmd.writeError(`ssh-keygen: ${path}: no public key\n`);
    return 1;
  }

  const fp = await fingerprint(blob);
  const bits = key.type === 'ssh-rsa' ? rsaBits(blob) : KEY_BITS[key.type] ?? 0;
  const label = KEY_LABELS[key.type] ?? (key.type.startsWith('ecdsa') ? 'ECDSA' : key.type);
  if (cmd.json) {
    await cmd.writeJSON({ bits, fingerprint: fp, comment: key.comment ?? '', type: label } satisfies SshKeyFingerprint);
  } else {
    await cmd.write(`${bits} ${fp} ${key.comment || 'no comment'} (${label})\n`);
  }
  return 0;
}

async function forgetHost(cmd: Command, spec: string, file: string): Promise<number> {
  // `[host]:port` as known_hosts files it, or a bare host
  const m = spec.match(/^\[(.+)\]:(\d+)$/);
  const host = m ? m[1] : spec;
  const port = m ? Number.parseInt(m[2], 10) : 22;

  const text = await readText(cmd.sys.vfs, cmd.access, file);
  if (text === undefined) {
    await cmd.writeError(`ssh-keygen: ${file}: No such file or directory\n`);
    return 1;
  }

  const { text: kept, removed } = await removeHost(text, host, port);
  if (!removed.length) {
    await cmd.writeError(`Host ${spec} not found in ${file}\n`);
    return 1;
  }

  await writeText(cmd.sys.vfs, cmd.access, file, kept, 0o600);
  for (const line of removed) await cmd.write(`# Host ${spec} found: line ${line}\n`);
  await cmd.write(`${file} updated.\n`);
  return 0;
}

export const sshKeygen = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['t', 'b', 'f', 'C', 'N', 'R'],
    boolean: ['l', 'q', 'y'],
  });

  const home = cmd.env.HOME;
  const vfs = cmd.sys.vfs;
  const access = cmd.access;

  if (flags.R) {
    const file = flags.f ? resolve(cmd.cwd, flags.f) : `${sshDir(home)}/known_hosts`;
    return await forgetHost(cmd, flags.R, file);
  }

  const typeName = (flags.t ?? 'ed25519').toLowerCase();
  const type = TYPES[typeName];

  if (flags.l || flags.y) {
    const path = flags.f ? resolve(cmd.cwd, flags.f) : `${sshDir(home)}/${type?.file ?? 'id_ed25519'}`;
    if (flags.l) return await showFingerprint(cmd, path);

    // -y: the public key of a private key file
    const text = await readText(vfs, access, path);
    let parsed = text !== undefined ? parseKey(text) : new Error('No such file or directory');
    if (parsed instanceof Error && text !== undefined && /passphrase/i.test(parsed.message)) {
      const passphrase = flags.N ?? (cmd.tty ? await cmd.prompt('Enter passphrase: ', 'secret') : '');
      parsed = await parseKey(text, passphrase);
    }
    if (parsed instanceof Error) {
      await cmd.writeError(`ssh-keygen: ${path}: ${parsed.message}\n`);
      return 1;
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    const blob = key.getPublicSSH()!;
    await cmd.write(`${key.type} ${encodeBase64(blob)}${key.comment ? ` ${key.comment}` : ''}\n`);
    return 0;
  }

  if (!type) {
    await cmd.writeError(`ssh-keygen: unknown key type ${flags.t}; use ed25519, ecdsa or rsa\n`);
    return 1;
  }

  const bits = flags.b ? Number.parseInt(flags.b, 10) : type.bits;
  if (typeName === 'rsa' && (!bits || bits < 2048)) {
    await cmd.writeError('ssh-keygen: RSA keys must be at least 2048 bits\n');
    return 1;
  }
  if (typeName === 'ecdsa' && ![256, 384, 521].includes(bits ?? 0)) {
    await cmd.writeError('ssh-keygen: ECDSA keys are 256, 384 or 521 bits\n');
    return 1;
  }

  const path = flags.f ? resolve(cmd.cwd, flags.f) : `${sshDir(home)}/${type.file}`;
  if (!flags.f) await ensureSshDir(vfs, access, home);

  if (!flags.q) await cmd.write(`Generating public/private ${typeName} key pair.\n`);

  if (await vfs.exists(access, path)) {
    const answer = cmd.tty ? await cmd.prompt(`${path} already exists.\nOverwrite (y/n)? `) : 'n';
    if (!/^y(es)?$/i.test(answer.trim())) {
      if (!cmd.tty) await cmd.writeError(`ssh-keygen: ${path} already exists\n`);
      return 1;
    }
  }

  let passphrase = flags.N;
  if (passphrase === undefined) {
    if (cmd.tty) {
      passphrase = await cmd.prompt('Enter passphrase (empty for no passphrase): ', 'secret');
      const again = await cmd.prompt('Enter same passphrase again: ', 'secret');
      if (again !== passphrase) {
        await cmd.writeError('Passphrases do not match.  Try again.\n');
        return 1;
      }
    } else {
      passphrase = '';
    }
  }

  const comment = flags.C ?? `${cmd.env.USER}@ein`;
  const pair = await generateKeyPair(typeName, {
    bits,
    comment,
    format: 'new',
    ...(passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 16 } : {}),
  });

  await writeText(vfs, access, path, pair.private, 0o600);
  await writeText(vfs, access, `${path}.pub`, `${pair.public}\n`, 0o644);

  const parsed = parseKey(pair.public);
  const blob = parsed instanceof Error ? undefined : (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
  const fp = blob ? await fingerprint(blob) : '';

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, path, publicKeyPath: `${path}.pub`, fingerprint: fp } satisfies SshKeyPairCreated);
  } else if (!flags.q) {
    await cmd.write(`Your identification has been saved in ${path}\n`);
    await cmd.write(`Your public key has been saved in ${path}.pub\n`);
    await cmd.write(`The key fingerprint is:\n${fp} ${comment}\n`);
  }
  return 0;
};

sshKeygen.spec = {
  name: 'ssh-keygen',
  effect: 'write' as const,
  description: 'Make an SSH key pair in ~/.ssh, show a fingerprint (-l) or forget a host key (-R)',
  args: [],
  flags: [
    { name: 't', type: 'string' as const, description: 'key type: ed25519 (default), ecdsa, rsa' },
    { name: 'b', type: 'number' as const, description: 'bits: RSA 3072 (default) or more, ECDSA 256/384/521' },
    { name: 'f', type: 'path' as const, description: 'key file (default ~/.ssh/id_<type>)' },
    { name: 'C', type: 'string' as const, description: 'comment (default <user>@ein)' },
    { name: 'N', type: 'string' as const, description: 'passphrase; asked for when omitted at a terminal' },
    { name: 'q', type: 'bool' as const, description: 'quiet' },
    { name: 'l', type: 'bool' as const, description: "show the key file's fingerprint instead", writes: false },
    { name: 'y', type: 'bool' as const, description: 'print the public key of a private key file', writes: false },
    { name: 'R', type: 'string' as const, description: 'remove a host ([host]:port off port 22) from known_hosts' },
  ],
  examples: [
    'ssh-keygen',
    'ssh-keygen -t rsa -b 4096 -C "backup key"',
    'ssh-keygen -l -f ~/.ssh/id_ed25519.pub',
    'ssh-keygen -R nas.local',
  ],
  returns: 'nothing; with -l the key size, fingerprint, comment and type.',
};
