/**
 * Parsing `[user@]host[:path]` the way ssh and scp read it.
 */

interface SshTarget {
  /** Remote user; the caller falls back to the local user when absent */
  user?: string;
  host: string;
  port?: number;
}

export interface ScpOperand extends SshTarget {
  /** Remote path; empty means the remote user's home directory */
  path: string;
}

/**
 * `[user@]host`, `[user@]host:port` is not accepted (ssh takes `-p`), but an
 * IPv6 literal may be bracketed: `anna@[fe80::1]`.
 */
export function parseSshTarget(spec: string): SshTarget {
  if (!spec) throw new Error('missing host');

  const at = spec.lastIndexOf('@');
  const user = at >= 0 ? spec.slice(0, at) : undefined;
  let host = at >= 0 ? spec.slice(at + 1) : spec;

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new Error(`missing host in '${spec}'`);
  if (user === '') throw new Error(`missing user in '${spec}'`);

  return { user, host };
}

/**
 * An scp operand is remote when a `:` comes before any `/` (so `./a:b` and
 * `/x/a:b` stay local), as OpenSSH decides it. Answers undefined for a local
 * path.
 */
export function parseScpOperand(spec: string): ScpOperand | undefined {
  let hostEnd: number;
  let pathStart: number;

  const at = spec.indexOf('@');
  const hostStart = at >= 0 && at < spec.search(/[:/]|$/) ? at + 1 : 0;

  if (spec[hostStart] === '[') {
    // [ipv6]:path
    const close = spec.indexOf(']', hostStart);
    if (close < 0 || spec[close + 1] !== ':') return undefined;
    hostEnd = close + 1;
    pathStart = close + 2;
  } else {
    const colon = spec.indexOf(':');
    const slash = spec.indexOf('/');
    if (colon <= 0 || (slash >= 0 && slash < colon)) return undefined;
    hostEnd = colon;
    pathStart = colon + 1;
  }

  const target = parseSshTarget(spec.slice(0, hostEnd));
  return { ...target, path: spec.slice(pathStart) };
}

/** `user@host`, bracketing an IPv6 literal, for messages */
export function formatTarget(target: SshTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return target.user ? `${target.user}@${host}` : host;
}
