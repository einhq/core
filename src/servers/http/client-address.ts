/**
 * The address of the client behind an HTTP request, as `who` shows it.
 */

/** Whether `hostname` is this host: the only peer whose forwarding headers are believed. */
const isLoopback = (hostname: string): boolean => hostname === '::1' || hostname.startsWith('127.') || hostname.startsWith('::ffff:127.');

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
 * The client's address: the socket's peer, or, when that peer is a proxy on this host, the first
 * hop it names in `X-Forwarded-For` or `Forwarded`. Anyone else's forwarding headers are ignored,
 * so a client cannot make `who` show an address it does not have.
 */
export function clientAddress(headers: Headers, remoteAddr: Deno.Addr): string | undefined {
  if (remoteAddr.transport !== 'tcp' && remoteAddr.transport !== 'udp') return undefined;
  if (!isLoopback(remoteAddr.hostname)) return remoteAddr.hostname;
  return forwardedFor(headers) ?? remoteAddr.hostname;
}
