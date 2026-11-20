/**
 * Whether a request came from a page of EiN's own origin. The session cookie is `SameSite=Lax`, so a
 * browser sends it from every same-site page: another port of the same host, or a sibling host
 * name of the same domain. Those pages are not EiN's, and only the browser's own word on where a
 * request came from tells them apart (ein/core#1373).
 */

/** `host[:port]` as an origin of `scheme` names it: lowercase, without the scheme's default port. */
function originHost(scheme: string, host: string): string {
  const lower = host.toLowerCase();
  const defaultPort = scheme === 'https:' ? ':443' : scheme === 'http:' ? ':80' : '';
  return defaultPort && lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower;
}

/**
 * Whether the browser says `headers` come from a page of another origin than the one it sent them
 * to. `Sec-Fetch-Site` is its direct answer, sent only over HTTPS; otherwise the host `Origin` names
 * must be the `Host` the request was sent to. The scheme is not compared: behind a TLS-terminating
 * proxy the page is `https:` and the request reaches EiN over plain HTTP. A request with neither
 * header is not a browser's, which sends `Origin` with every WebSocket handshake and every write.
 */
export function isCrossOrigin(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = headers.get('origin');
  if (origin === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // `null`, from a sandboxed page or a redirect across origins.
    return true;
  }
  return url.host !== originHost(url.protocol, headers.get('host') ?? '');
}
