/**
 * The user's SSH identities, offered to a server the way OpenSSH does: every
 * default key (or the one named with `-i`), public half first, and a passphrase
 * asked for only once the server has said it would accept that key.
 */

import { BaseAgent, type ParsedKey, parseKey, type SignOptions } from 'ssh2';
import type { Access } from '../access/types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { readText, sshDir } from './files.ts';

/** Tried in this order when no identity is named, as OpenSSH does */
export const DEFAULT_IDENTITIES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

interface Identity {
  path: string;
  /** Public key the server is asked about; unknown for an encrypted key without a .pub until unlocked */
  publicKey?: ParsedKey;
  /** The private key, once readable (unencrypted, or after the passphrase) */
  privateKey?: ParsedKey;
  /** The private key file's text, kept for decrypting on demand */
  privateText: string;
}

type PassphrasePrompt = (path: string) => Promise<string | undefined>;

function isEncryptedError(err: Error): boolean {
  return /passphrase/i.test(err.message);
}

function firstKey(parsed: ParsedKey | ParsedKey[]): ParsedKey {
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/**
 * Read identities from the VFS. An explicit path must exist; default ones are
 * skipped when missing. A key that cannot be parsed at all is reported via
 * `warn` and skipped, and so is an encrypted one without a `.pub` next to it
 * when there is no one to ask for its passphrase.
 */
export async function loadIdentities(
  vfs: NodeVFS,
  access: Access,
  home: string,
  opts: { explicit?: string; canAsk: boolean; warn: (msg: string) => Promise<void> },
): Promise<Identity[]> {
  const paths = opts.explicit ? [opts.explicit] : DEFAULT_IDENTITIES.map((name) => `${sshDir(home)}/${name}`);
  const identities: Identity[] = [];

  for (const path of paths) {
    const privateText = await readText(vfs, access, path);
    if (privateText === undefined) {
      if (opts.explicit) await opts.warn(`Warning: Identity file ${path} not accessible: No such file or directory.\n`);
      continue;
    }

    const parsed = parseKey(privateText);
    if (!(parsed instanceof Error)) {
      const key = firstKey(parsed);
      identities.push({ path, publicKey: key, privateKey: key, privateText });
      continue;
    }

    if (!isEncryptedError(parsed)) {
      await opts.warn(`Load key "${path}": ${parsed.message}\n`);
      continue;
    }

    // Encrypted: the .pub is enough to ask the server first
    const pubText = await readText(vfs, access, `${path}.pub`);
    const pub = pubText !== undefined ? parseKey(pubText) : undefined;
    if (pub && !(pub instanceof Error)) {
      identities.push({ path, publicKey: firstKey(pub), privateText });
    } else if (opts.canAsk) {
      // No .pub: decrypt up front to learn the public key
      identities.push({ path, privateText });
    } else {
      await opts.warn(`Load key "${path}": encrypted, and no one to ask for its passphrase\n`);
    }
  }

  return identities;
}

/** Decrypt an identity with a passphrase from `ask`, up to three tries */
export async function unlockIdentity(identity: Identity, ask: PassphrasePrompt): Promise<ParsedKey | undefined> {
  if (identity.privateKey) return identity.privateKey;

  for (let attempt = 0; attempt < 3; attempt++) {
    const passphrase = await ask(identity.path);
    if (passphrase === undefined || passphrase === '') return undefined;
    const parsed = await parseKey(identity.privateText, passphrase);
    if (!(parsed instanceof Error)) {
      identity.privateKey = firstKey(parsed);
      identity.publicKey ??= identity.privateKey;
      return identity.privateKey;
    }
  }
  return undefined;
}

function signAlgo(key: ParsedKey, options?: SignOptions): string | undefined {
  if (key.type !== 'ssh-rsa') return undefined;
  if (options?.hash === 'sha512') return 'rsa-sha2-512';
  if (options?.hash === 'sha256') return 'rsa-sha2-256';
  return undefined;
}

/**
 * An agent held in memory over a list of identities, so the ssh2 client can
 * offer more than one key. Signing an encrypted identity asks for its
 * passphrase at that moment.
 */
export class IdentityAgent extends BaseAgent {
  constructor(private identities: Identity[], private ask?: PassphrasePrompt) {
    super();
  }

  /** Identities whose public key is still unknown (encrypted, no .pub) are left out: unlock them first */
  override async getIdentities(): Promise<ParsedKey[]> {
    return this.identities.flatMap((identity) => identity.publicKey ? [identity.publicKey] : []);
  }

  override async sign(pubKey: ParsedKey | Uint8Array, data: Uint8Array, options?: SignOptions): Promise<Uint8Array> {
    const identity = this.identities.find((id) => id.publicKey?.equals(pubKey as ParsedKey));
    if (!identity) throw new Error('unknown identity');

    const key = identity.privateKey ?? (this.ask ? await unlockIdentity(identity, this.ask) : undefined);
    if (!key) throw new Error(`no passphrase for ${identity.path}`);

    const signature = await key.sign(data, signAlgo(key, options));
    if (signature instanceof Error) throw signature;
    return signature;
  }
}
