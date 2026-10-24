/**
 * Opening an SSH connection from EiN to another machine as an EiN user: their
 * keys and known_hosts under `~/.ssh` in the VFS, questions (unknown host key,
 * password, passphrase) put to the person at the terminal when there is one.
 */

import { Client } from 'ssh2';
import { ADMIN_ACCESS, SSH_GROUPNAME } from '../access/constants.ts';
import { isAdmin } from '../access/verify-access.ts';
import type { Access } from '../access/types.ts';
import { GROUPS_PATH } from '../paths.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { appendLine, ensureSshDir, readText, sshDir } from './files.ts';
import { IdentityAgent, loadIdentities, unlockIdentity } from './keys.ts';
import { checkHostKey, fingerprint, hostKeyFromBlob, knownHostsLine, knownHostsName } from './known-hosts.ts';

/** OpenSSH's StrictHostKeyChecking: what to do with an unknown host key */
export type StrictHostKeyChecking =
  /** Ask the person (default); refuse when there is no one to ask */
  | 'ask'
  /** Only hosts already in known_hosts */
  | 'yes'
  /** Add unknown hosts without asking; still refuse a changed key */
  | 'accept-new'
  /** Add unknown hosts and connect despite a changed key, with a warning */
  | 'no';

/** Who is connecting, and how to reach the person behind it */
export interface SshUser {
  vfs: NodeVFS;
  access: Access;
  /** Local user name: the remote user when none is given */
  user: string;
  /** Home directory holding `.ssh` */
  home: string;
  /** Ask the person at the terminal; absent when there is none */
  ask?: (prompt: string, secret: boolean) => Promise<string>;
  /** Diagnostics for the person (stderr) */
  warn: (text: string) => Promise<void>;
}

export interface SshConnectOptions {
  host: string;
  port?: number;
  user?: string;
  /** Identity file to use instead of the default ones */
  identity?: string;
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Accept exactly this host key (`SHA256:…`), ignoring known_hosts */
  hostKeyFingerprint?: string;
  /** Offer password and keyboard-interactive auth (default: when someone can be asked) */
  passwordAuth?: boolean;
  /** Never ask anything, as OpenSSH's BatchMode */
  batchMode?: boolean;
  /** Milliseconds for the TCP connect, handshake and auth, prompts excluded (default 15000) */
  connectTimeout?: number;
  /** Keepalive interval in milliseconds; 0 disables (default) */
  keepaliveInterval?: number;
  /** Ends the attempt, e.g. on Ctrl-C */
  signal?: AbortSignal;
}

/** A connection that could not be made; `message` is ready to show */
export class SshConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshConnectError';
  }
}

const KEY_LABELS: Record<string, string> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA',
  'ecdsa-sha2-nistp521': 'ECDSA',
};

function keyLabel(type: string): string {
  return KEY_LABELS[type] ?? type;
}

/**
 * Whether this user may open outbound connections: the admin, or a member of
 * the `ssh` group. The group's gid is looked up, since it is assigned at boot.
 */
export async function sshAllowed(vfs: NodeVFS, access: Access): Promise<boolean> {
  if (isAdmin(access)) return true;
  try {
    const group = await vfs.get(ADMIN_ACCESS, `${GROUPS_PATH}/${SSH_GROUPNAME}`);
    const gid = group.attrs.gid;
    return typeof gid === 'number' && access.gids.includes(gid);
  } catch {
    return false;
  }
}

function changedWarning(label: string, fp: string, knownHosts: string, lines: number[]): string {
  return [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    `The fingerprint for the ${label} key sent by the remote host is`,
    `${fp}.`,
    `Add the correct host key in ${knownHosts} to get rid of this message.`,
    ...lines.map((n) => `Offending ${label} key in ${knownHosts}:${n}`),
    '',
  ].join('\n');
}

/**
 * Checks the server's host key against known_hosts (or a pinned fingerprint),
 * asking about an unknown one. Records why it refused, since the ssh2 client
 * only reports that it did.
 */
function hostKeyVerifier(u: SshUser, o: SshConnectOptions, ask: SshUser['ask']) {
  const port = o.port ?? 22;
  const policy = o.strictHostKeyChecking ?? 'ask';
  const knownHostsPath = `${sshDir(u.home)}/known_hosts`;
  const name = knownHostsName(o.host, port);
  const state: { failure?: string } = {};

  const addKey = async (line: string, label: string) => {
    await ensureSshDir(u.vfs, u.access, u.home);
    await appendLine(u.vfs, u.access, knownHostsPath, line);
    await u.warn(`Warning: Permanently added '${name}' (${label}) to the list of known hosts.\n`);
  };

  const verify = async (raw: Uint8Array | string): Promise<boolean> => {
    const key = hostKeyFromBlob(raw as Uint8Array);
    const label = keyLabel(key.type);
    const fp = await fingerprint(key.blob);

    if (o.hostKeyFingerprint) {
      if (fp === o.hostKeyFingerprint) return true;
      state.failure = `host key for ${name} is ${fp}, not the expected ${o.hostKeyFingerprint}`;
      return false;
    }

    const check = await checkHostKey(await readText(u.vfs, u.access, knownHostsPath) ?? '', o.host, port, key);

    switch (check.status) {
      case 'match':
        return true;

      case 'revoked':
        state.failure = `Host key ${label} ${fp} for ${name} is marked as revoked.\nHost key verification failed.`;
        return false;

      case 'changed':
        if (policy === 'no') {
          await u.warn(changedWarning(label, fp, knownHostsPath, check.changedLines));
          return true;
        }
        state.failure = changedWarning(label, fp, knownHostsPath, check.changedLines) +
          'Host key verification failed.';
        return false;

      case 'unknown': {
        const line = knownHostsLine(o.host, port, key);
        if (policy === 'accept-new' || policy === 'no') {
          await addKey(line, label);
          return true;
        }
        if (policy === 'yes' || !ask) {
          state.failure = `No ${label} host key is known for ${name}` +
            (policy === 'yes' ? ' and you have requested strict checking.' : '.') +
            `\nIts fingerprint is ${fp}. Connect once from an interactive shell to accept it.` +
            '\nHost key verification failed.';
          return false;
        }

        const others = check.otherTypes.length ? `\nThis host is known with a different key type (${check.otherTypes.join(', ')}).` : '';
        let answer = (await ask(
          `The authenticity of host '${name}' can't be established.\n${label} key fingerprint is ${fp}.${others}\n` +
            'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
          false,
        )).trim();
        while (answer !== 'yes' && answer !== 'no' && answer !== fp) {
          answer = (await ask("Please type 'yes', 'no' or the fingerprint: ", false)).trim();
        }
        if (answer === 'no') {
          state.failure = 'Host key verification failed.';
          return false;
        }
        await addKey(line, label);
        return true;
      }
    }
  };

  return { verify, state };
}

function describeError(err: unknown, o: SshConnectOptions): string {
  const e = err as Error & { level?: string };
  const port = o.port ?? 22;
  if (e instanceof Deno.errors.ConnectionRefused) return `connect to host ${o.host} port ${port}: Connection refused`;
  if (e?.level === 'client-timeout' || /timeout/i.test(e?.message ?? '')) {
    return `connect to host ${o.host} port ${port}: Connection timed out`;
  }
  if (e?.level === 'client-authentication') return `${o.user}@${o.host}: Permission denied.`;
  if (/lookup|resolve|dns|name or service/i.test(e?.message ?? '')) {
    return `Could not resolve hostname ${o.host}: Name or service not known`;
  }
  return `${o.host}: ${e?.message ?? String(err)}`;
}

/**
 * Connect and authenticate. Keys are offered first (every default identity, or
 * `identity`), then keyboard-interactive and password when someone can answer.
 */
export async function connectSsh(u: SshUser, opts: SshConnectOptions): Promise<Client> {
  const o: SshConnectOptions = { ...opts, user: opts.user || u.user, port: opts.port ?? 22 };
  const ask = o.batchMode ? undefined : u.ask;
  const passphrase = ask ? (path: string) => ask(`Enter passphrase for key '${path}': `, true) : undefined;

  const identities = await loadIdentities(u.vfs, u.access, u.home, {
    explicit: o.identity,
    canAsk: !!passphrase,
    warn: u.warn,
  });
  // A key with no .pub must be unlocked to learn what to offer; do it before
  // the connection, rather than while the server waits
  for (const identity of identities) {
    if (!identity.publicKey && passphrase) await unlockIdentity(identity, passphrase);
  }

  const passwordAuth = (o.passwordAuth ?? true) && !!ask;
  const verifier = hostKeyVerifier(u, o, ask);
  const client = new Client();

  if (passwordAuth) {
    client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
      (async () => {
        if (instructions) await u.warn(`${instructions}\n`);
        const answers: string[] = [];
        for (const p of prompts) answers.push(await ask!(p.prompt, !p.echo));
        finish(answers);
      })().catch(() => finish([]));
    });
  }

  const onAbort = () => client.end();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await client.connect({
      host: o.host,
      port: o.port,
      username: o.user,
      agent: identities.length ? new IdentityAgent(identities, passphrase) : undefined,
      password: passwordAuth ? () => ask!(`${o.user}@${o.host}'s password: `, true) : undefined,
      tryKeyboard: passwordAuth,
      readyTimeout: o.connectTimeout ?? 15000,
      keepaliveInterval: o.keepaliveInterval ?? 0,
      hostVerifier: verifier.verify,
    });
  } catch (err) {
    client.end();
    if (o.signal?.aborted) throw new SshConnectError('interrupted');
    throw new SshConnectError(verifier.state.failure ?? describeError(err, o));
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }

  return client;
}
