/** A request body longer than a handler takes. */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`the body is larger than ${limit} bytes`);
  }
}

/**
 * A request's body, read in full only while it stays within `limit` bytes: a declared length over
 * it is refused before anything is read, and a body that grows past it is cancelled there.
 * @throws BodyTooLargeError
 */
export async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length'));
  if (declared > limit) {
    await req.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(limit);
  }
  if (!req.body) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The answer to a body over its limit. */
export const tooLarge = (error: BodyTooLargeError, headers: HeadersInit = {}): Response =>
  new Response(`the body is larger than ${error.limit} bytes`, { status: 413, headers });
