import { isGuest } from '../../../lib/access/mod.ts';
import { NOT_DERIVED } from '../../../lib/kinds/mod.ts';
import { BodyTooLargeError, readBody, tooLarge } from '../body-limit.ts';
import { appOrSessionAccess } from '../app-access.ts';
import { HttpServerConfig } from '../types.ts';

/** Checksums one request asks about at most. */
export const CHECKSUMS_MAX = 1000;

/** Room for `CHECKSUMS_MAX` checksums of 64 hex digits, quoted and separated. */
const CHECKSUMS_BODY_LIMIT = 128 * 1024;

/** Checksums one query looks up. */
const CHECKSUMS_AT_ONCE = 500;

/** Rows one query reads at a time. */
const PAGE = 1000;

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * POST /checksums — which of a list of sha256 checksums the asker already has: a file they can
 * read anywhere in the tree, their staging included, carries it. A file in a trash, and a
 * rendition, does not count. The answer says known or not and nothing else, never where, so an
 * app sends only the files the archive lacks. It signs in with the session cookie, or with the EiN
 * app's token as the account the phone was paired as.
 *
 * Body: `{ sha256: string[] }`, 1 to `CHECKSUMS_MAX` checksums in hex. Response: `{ known: string[] }`,
 * the known ones in lowercase, in the order asked.
 */
export async function handlePostChecksums(config: HttpServerConfig, req: Request, from: string | undefined): Promise<Response> {
  const access = await appOrSessionAccess(config, req, from, 'a checksum question');
  const responseHeaders = new Headers();
  if (!access || isGuest(access)) return new Response('sign in first', { status: 401, headers: responseHeaders });

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBody(req, CHECKSUMS_BODY_LIMIT)));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge(error, responseHeaders);
    return new Response('invalid JSON body', { status: 400, headers: responseHeaders });
  }

  const asked = (body as { sha256?: unknown } | null)?.sha256;
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > CHECKSUMS_MAX) {
    return new Response(`sha256 must be an array of 1 to ${CHECKSUMS_MAX} checksums`, { status: 400, headers: responseHeaders });
  }
  const bad = asked.find((value) => typeof value !== 'string' || !SHA256.test(value.toLowerCase()));
  if (bad !== undefined) return new Response(`not a sha256 checksum in hex: ${JSON.stringify(bad)}`, { status: 400, headers: responseHeaders });

  const wanted = [...new Set((asked as string[]).map((value) => value.toLowerCase()))];
  const found = new Set<string>();
  for (let at = 0; at < wanted.length; at += CHECKSUMS_AT_ONCE) {
    const chunk = wanted.slice(at, at + CHECKSUMS_AT_ONCE);
    let after: { value: string | null; id: string } | undefined;
    for (;;) {
      // The query leaves out what `access` cannot reach and every path inside a trash.
      const rows = await config.vfs.query(access, {
        types: ['file'],
        where: [{ ref: 'sha256', op: 'in', value: chunk }, NOT_DERIVED],
        ...(after ? { after } : {}),
        limit: PAGE,
      });
      for (const row of rows) found.add(String(row.node.attrs.sha256));
      if (rows.length < PAGE || chunk.every((sha256) => found.has(sha256))) break;
      after = { value: null, id: rows[rows.length - 1].id };
    }
  }

  responseHeaders.set('Content-Type', 'application/json');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ known: wanted.filter((sha256) => found.has(sha256)) }), { status: 200, headers: responseHeaders });
}
