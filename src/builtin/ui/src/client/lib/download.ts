/**
 * Download the original files behind a set of media items.
 *
 * A single item is fetched straight from `/file/<path>`: it needs no archive, and a
 * `download` anchor supplies the filename the endpoint does not set.
 *
 * Anything more goes through the archive endpoint, because N requests is not a bulk
 * download — the browser prompts once for permission to save multiple files, then drops
 * whatever arrives too fast, and what survives lands loose in Downloads. `POST /archive`
 * parks the selection and answers with a URL that streams it as one zip; that URL is a
 * plain navigation, so the browser treats it as the single download it is.
 */

import { fileUrl } from './file-url.ts';

/** Save a same-origin URL, using `name` when the response sets no filename of its own. */
function saveUrl(url: string, name?: string): void {
  const link = document.createElement('a');
  link.href = url;
  if (name) link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * A name for the archive, taken from the folder the selection came out of.
 *
 * `IMG_4021.jpg`-style names say nothing once the zip is on a desktop, so the archive is
 * named after what the items have in common — the album, when they share one. A selection
 * spanning the timeline or a search has no such folder, and gets the server's dated default
 * instead. `files/` is skipped: an album stores its members under it, so it names every
 * album identically.
 */
export function archiveNameFromPaths(paths: string[]): string | undefined {
  const folders = paths.map((path) => path.split('/').slice(0, -1));
  const [first, ...rest] = folders;
  if (!first) return undefined;

  let shared = first;
  for (const folder of rest) {
    let i = 0;
    while (i < shared.length && i < folder.length && shared[i] === folder[i]) i++;
    shared = shared.slice(0, i);
  }

  while (shared.length > 0 && (shared[shared.length - 1] === '' || shared[shared.length - 1] === 'files')) {
    shared = shared.slice(0, -1);
  }

  return shared[shared.length - 1];
}

export async function downloadOriginals(items: { path: string; name: string }[], archiveName?: string): Promise<void> {
  if (items.length === 0) return;

  if (items.length === 1) {
    saveUrl(fileUrl(items[0].path), items[0].name);
    return;
  }

  const res = await fetch('/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: items.map((item) => item.path), name: archiveName }),
  });

  if (!res.ok) {
    // The endpoint answers a rejected selection in text, naming the path that caused it.
    throw new Error((await res.text()) || `archive request failed (${res.status})`);
  }

  const { url } = await res.json() as { url: string };
  // No `download` attribute: the server names the archive in Content-Disposition, and an
  // attribute here would override it with a guess made before the name was known.
  saveUrl(url);
}
