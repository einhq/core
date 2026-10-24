/**
 * Pattern cases shared by the JS matcher test and the queue registry's postgres cross-check. Kept
 * out of a test file so importing it does not also register that file's tests.
 */

/** `[pattern, key, matches]`. */
export const MATCH_CASES: [string, string, boolean][] = [
  // '*' is exactly one segment
  ['system.vfs.file.*', 'system.vfs.file.created', true],
  ['system.vfs.file.*', 'system.vfs.file.updated', true],
  ['system.vfs.file.*', 'system.vfs.file', false],
  ['system.vfs.file.*', 'system.vfs.file.a.b', false],
  ['system.vfs.*.created', 'system.vfs.exif.created', true],
  ['system.vfs.*.created', 'system.vfs.created', false],
  ['*', 'media', true],
  ['*', 'media.file', false],

  // '#' is zero or more segments
  ['media.#', 'media', true],
  ['media.#', 'media.file', true],
  ['media.#', 'media.file.discovered', true],
  ['media.#', 'mediax', false],
  ['media.#', 'other.media', false],
  ['#', 'anything.at.all', true],
  ['#', '', true],
  ['#.created', 'created', true],
  ['#.created', 'system.vfs.file.created', true],
  ['#.created', 'system.vfs.file.updated', false],
  ['system.#.created', 'system.created', true],
  ['system.#.created', 'system.vfs.created', true],
  ['system.#.created', 'system.vfs.file.created', true],
  ['system.#.created', 'system.vfs.file.deleted', false],

  // wildcards are whole segments only
  ['system.vfs.fi*.created', 'system.vfs.file.created', false],
  ['system.vfs.fi*.created', 'system.vfs.fi*.created', true],

  // a literal key matches itself and nothing else
  ['system.vfs.file.created', 'system.vfs.file.created', true],
  ['system.vfs.file.created', 'system.vfs.file.updated', false],
];
