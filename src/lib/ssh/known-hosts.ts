/**
 * OpenSSH `known_hosts`: matching a server's host key against the file, and
 * the line to append for a newly accepted one.
 *
 * Supported: comma-separated host patterns with `*`/`?` wildcards and `!`
 * negation, `[host]:port` for non-standard ports, hashed hosts (`|1|salt|hash`)
 * and the `@revoked` marker. `@cert-authority` lines are skipped: host
 * certificates are not verified.
 */

import { decodeBase64, encodeBase64 } from '@std/encoding';

type HostKeyStatus =
  /** A line for this host holds exactly this key */
  | 'match'
  /** A line for this host holds a different key of the same type */
  | 'changed'
  /** The key is marked `@revoked` */
  | 'revoked'
  /** Nothing is known about this host with this key type */
  | 'unknown';

interface HostKey {
  /** e.g. `ssh-ed25519` */
  type: string;
  /** The raw public key blob, as sent by the server */
  blob: Uint8Array;
}

interface HostKeyCheck {
  status: HostKeyStatus;
  /** 1-based line numbers of the entries for this host whose key differs */
  changedLines: number[];
  /** Key types known for this host other than the one presented */
  otherTypes: string[];
}

/** The name a host is filed under: `host`, or `[host]:port` off port 22 */
export function knownHostsName(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** The first SSH string in a public key blob is its type */
export function hostKeyFromBlob(blob: Uint8Array): HostKey {
  const len = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0);
  const type = new TextDecoder().decode(blob.subarray(4, 4 + len));
  return { type, blob };
}

/** `SHA256:…` as OpenSSH prints it (unpadded base64) */
export async function fingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(blob)));
  return `SHA256:${encodeBase64(digest).replace(/=+$/, '')}`;
}

export function knownHostsLine(host: string, port: number, key: HostKey): string {
  return `${knownHostsName(host, port)} ${key.type} ${encodeBase64(key.blob)}`;
}

/** Glob match as OpenSSH's match_pattern: `*` and `?`, case-insensitive */
function globMatch(name: string, pattern: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i',
  );
  return re.test(name);
}

async function hashedMatch(name: string, field: string): Promise<boolean> {
  // |1|base64(salt)|base64(HMAC-SHA1(salt, name))
  const parts = field.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  try {
    const salt = decodeBase64(parts[2]);
    const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(name)));
    return encodeBase64(mac) === parts[3];
  } catch {
    return false;
  }
}

/** Whether a line's host field names this host; a matching `!pattern` vetoes */
async function hostFieldMatches(name: string, field: string): Promise<boolean> {
  if (field.startsWith('|')) return await hashedMatch(name, field);

  let matched = false;
  for (const pattern of field.split(',')) {
    if (pattern.startsWith('!')) {
      if (globMatch(name, pattern.slice(1))) return false;
    } else if (globMatch(name, pattern)) {
      matched = true;
    }
  }
  return matched;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function checkHostKey(
  knownHosts: string,
  host: string,
  port: number,
  key: HostKey,
): Promise<HostKeyCheck> {
  const name = knownHostsName(host, port);
  const changedLines: number[] = [];
  const otherTypes = new Set<string>();
  let matched = false;

  const lines = knownHosts.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    let marker: string | undefined;
    if (fields[0].startsWith('@')) marker = fields.shift();
    if (marker === '@cert-authority') continue;

    const [hostField, type, keyB64] = fields;
    if (!hostField || !type || !keyB64) continue;
    if (!await hostFieldMatches(name, hostField)) continue;

    let blob: Uint8Array;
    try {
      blob = decodeBase64(keyB64);
    } catch {
      continue;
    }

    if (marker === '@revoked') {
      if (sameBytes(blob, key.blob)) return { status: 'revoked', changedLines: [i + 1], otherTypes: [] };
      continue;
    }

    if (type !== key.type) {
      otherTypes.add(type);
    } else if (sameBytes(blob, key.blob)) {
      matched = true;
    } else {
      changedLines.push(i + 1);
    }
  }

  // A matching line wins over a stale one for the same host, as in OpenSSH
  if (matched) return { status: 'match', changedLines: [], otherTypes: [] };
  if (changedLines.length) return { status: 'changed', changedLines, otherTypes: [...otherTypes] };
  return { status: 'unknown', changedLines: [], otherTypes: [...otherTypes] };
}

/**
 * known_hosts without the lines naming this host (as `ssh-keygen -R`): the new
 * text and the 1-based numbers of the lines taken out.
 */
export async function removeHost(knownHosts: string, host: string, port = 22): Promise<{ text: string; removed: number[] }> {
  const name = knownHostsName(host, port);
  const kept: string[] = [];
  const removed: number[] = [];

  const lines = knownHosts.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].trim().split(/\s+/);
    if (fields[0]?.startsWith('@')) fields.shift();
    const hostField = fields[0];
    if (hostField && !hostField.startsWith('#') && await hostFieldMatches(name, hostField)) {
      removed.push(i + 1);
    } else {
      kept.push(lines[i]);
    }
  }
  return { text: kept.join('\n'), removed };
}
