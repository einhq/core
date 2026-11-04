/**
 * The address of the client behind an HTTP request, as `who` shows it.
 */

/** The addresses in `TRUSTED_PROXIES`, separated by commas or spaces. */
export const parseTrustedProxies = (value: string | undefined): Set<string> => new Set((value ?? '').split(/[\s,]+/).filter(Boolean));

/**
 * The proxies besides this host's loopback whose forwarding headers are believed: the deployment
 * names them when a proxy on this host reaches EiN from another address, as under rootless podman's
 * slirp4netns, where it comes from 10.0.2.2.
 */
const TRUSTED_PROXIES = parseTrustedProxies(Deno.env.get('TRUSTED_PROXIES'));

/** Whether `hostname` is a proxy whose forwarding headers are believed: this host, or one in `trusted`. */
const isTrustedProxy = (hostname: string, trusted: Set<string>): boolean =>
  hostname === '::1' || hostname.startsWith('127.') || hostname.startsWith('::ffff:127.') ||
  trusted.has(hostname) || trusted.has(hostname.replace(/^::ffff:/, ''));

/** `[2001:db8::1]:4711` → `2001:db8::1`, `192.0.2.7:4711` → `192.0.2.7`, `"…"` unquoted. */
const bareAddress = (value: string): string => {
  const address = value.trim().replaceAll('"', '');
  if (address.startsWith('[')) return address.slice(1).split(']')[0];
  // One colon is an IPv4 address with its port; more is a bare IPv6 address.
  const parts = address.split(':');
  return parts.length === 2 ? parts[0] : address;
};

/** The first hop of `X-Forwarded-For`, or the `for=` of the first `Forwarded` entry. */
const forwardedFor = (headers: Headers): string | undefined => {
  const xff = headers.get('x-forwarded-for')?.split(',')[0];
  if (xff?.trim()) return bareAddress(xff);

  const pair = headers.get('forwarded')?.split(',')[0].split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key.toLowerCase() === 'for');
  return pair?.[1] ? bareAddress(pair[1]) : undefined;
};

/**
 * The client's address: the socket's peer, or, when that peer is a proxy on this host or one in
 * `TRUSTED_PROXIES`, the first hop it names in `X-Forwarded-For` or `Forwarded`. Anyone else's
 * forwarding headers are ignored, so a client cannot make `who` show an address it does not have.
 */
export function clientAddress(headers: Headers, remoteAddr: Deno.Addr, trusted: Set<string> = TRUSTED_PROXIES): string | undefined {
  if (remoteAddr.transport !== 'tcp' && remoteAddr.transport !== 'udp') return undefined;
  if (!isTrustedProxy(remoteAddr.hostname, trusted)) return remoteAddr.hostname;
  return forwardedFor(headers) ?? remoteAddr.hostname;
}
