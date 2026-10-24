/**
 * `/file/<vfs path>` URLs — the one endpoint that serves node bytes, for reading
 * (`GET`), for writing a path (`PUT`) and for upload into a directory (`POST …/?name=`).
 *
 * A node name is free text: albums are named after what happened, and real ones
 * contain `?`, `&`, `#`, `%` and `+`. Splicing such a path straight into a URL breaks
 * it silently — `?` starts the query string, so the server sees a truncated path and
 * 404s, and `#` never leaves the browser at all. Every segment is therefore encoded on
 * its own; the server decodes it back with `decodeURIComponent`.
 */

/** Percent-encode a VFS path for use inside a URL, keeping its separators. */
export const encodeVfsPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The `/file` URL for a VFS path. Append literal suffixes (`/thumbnails/…`) to the result. */
export const fileUrl = (path: string): string => `/file${encodeVfsPath(path)}`;
