/**
 * Sending one file to `/upload/` in pieces (tus 1.0): the upload is begun with its length, its
 * name, its folder and its own time, then sent a piece at a time. A piece that fails on the way —
 * the connection dropped, a proxy cut it, the server restarted — is not sent again from the start:
 * the server is asked how much arrived and the upload goes on from there, after a pause that grows
 * while nothing gets through. Pure: the requests go through what the caller gives it.
 */

/** The bytes one request carries at most, so a slow connection still sends each in well under a minute. */
export const PIECE_BYTES = 8 * 1024 * 1024;

/** The pauses before asking again after a failure, the last repeated; past `RETRIES` in a row the file fails. */
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 20_000];
const RETRIES = 12;

/** A server's answer, or `status` 0 for a request that never got one. */
export type TusAnswer = { status: number; header: (name: string) => string | null; text: string };

/** What a sender asks of the browser. */
export type TusIo = {
  /** One request; rejects only when `signal` aborts it. `progress` is told the body's bytes sent. */
  request: (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Blob | undefined,
    progress: ((sent: number) => void) | undefined,
    signal: AbortSignal,
  ) => Promise<TusAnswer>;
  /** Wait `ms`, or reject when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** What a sender reads of a file: a browser `File`. */
type TusFile = Blob & { readonly name: string; readonly lastModified?: number };

const TUS = { 'Tus-Resumable': '1.0.0' };

/** The longest server answer a failure repeats. */
const ERROR_CHARS = 200;

/** `Upload-Metadata`: each key with its value in base64 of its UTF-8. */
export const tusMetadata = (pairs: Record<string, string>): string =>
  Object.entries(pairs).map(([key, value]) => `${key} ${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}`).join(',');

/** The tree path a `Content-Location` of `/file/…` names, or undefined when it names none. */
const storedPathOf = (answer: TusAnswer): string | undefined => {
  const location = answer.header('content-location');
  if (!location?.startsWith('/file/')) return undefined;
  return location.slice('/file'.length).split('/').map(decodeURIComponent).join('/');
};

/** Whether a failed request may succeed if asked again: no answer, or the server's own trouble. */
const transient = (status: number): boolean => status === 0 || status >= 500 || status === 429;

/**
 * The same for a piece, which may also have been cut short (400), have met the server still
 * reading the one before (409, 423), or be at another offset than the server (409).
 */
const pieceTransient = (status: number): boolean => transient(status) || status === 400 || status === 409 || status === 423;

const failure = (answer: TusAnswer, doing: string): Error =>
  new Error(answer.text.trim().slice(0, ERROR_CHARS) || (answer.status === 0 ? `network error ${doing}` : `upload refused (${answer.status})`));

/**
 * Send `file` into the folder `dir` at `endpoint`, calling `progress` with the bytes the server
 * holds and those of the piece on its way. Answers the path it was stored at, which may be a
 * numbered name beside a taken one. An abort through `signal` gives the upload up on the server.
 */
export async function sendInPieces(
  io: TusIo,
  file: TusFile,
  dir: string,
  progress: (sent: number) => void,
  signal: AbortSignal,
  endpoint = '/upload/',
): Promise<string> {
  const pairs: Record<string, string> = { filename: file.name, dir };
  if (file.lastModified) pairs.mtime = String(file.lastModified / 1000);
  const headers = { ...TUS, 'Upload-Length': String(file.size), 'Upload-Metadata': tusMetadata(pairs) };

  let failures = 0;
  const pause = async (answer: TusAnswer, doing: string, retries = transient) => {
    if (!retries(answer.status) || ++failures > RETRIES) throw failure(answer, doing);
    await io.sleep(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1], signal);
  };

  let created: TusAnswer;
  for (;;) {
    created = await io.request('POST', endpoint, headers, undefined, undefined, signal);
    if (created.status === 201) break;
    await pause(created, 'beginning the upload');
  }
  const location = created.header('location');
  if (!location) throw new Error('the server did not say where the upload is');
  const done = storedPathOf(created);
  if (done !== undefined) return done;

  try {
    let offset = 0;
    for (;;) {
      const piece = file.slice(offset, Math.min(offset + PIECE_BYTES, file.size));
      const at = offset;
      const answer = await io.request(
        'PATCH',
        location,
        { ...TUS, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        piece,
        (sent) => progress(at + sent),
        signal,
      );
      if (answer.status === 204) {
        const stored = storedPathOf(answer);
        if (stored !== undefined) return stored;
        offset = Number(answer.header('upload-offset'));
        failures = 0;
        progress(offset);
        continue;
      }
      await pause(answer, 'sending a piece', pieceTransient);
      const refused = answer;

      // Where the server is now: as far as the piece got, or done if only its answer was lost.
      for (;;) {
        const state = await io.request('HEAD', location, TUS, undefined, undefined, signal);
        if (state.status === 200) {
          const stored = storedPathOf(state);
          if (stored !== undefined) return stored;
          offset = Number(state.header('upload-offset'));
          progress(offset);
          break;
        }
        // A last piece whose file could not be stored takes the upload with it; its answer says why.
        if (state.status === 404) throw refused.text.trim() ? failure(refused, '') : new Error('the upload was lost on the server');
        await pause(state, 'asking how far the upload got');
      }
    }
  } catch (error) {
    if (signal.aborted) {
      void io.request('DELETE', location, TUS, undefined, undefined, new AbortController().signal).catch(() => {});
    }
    throw error;
  }
}
