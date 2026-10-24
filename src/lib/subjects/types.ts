/**
 * What a subject command answers `search --subject` and `search --group-by <kind>` with.
 *
 * A subject is a node media points at — a person in a picture, the location it was taken, the camera
 * that took it — and only the module that writes those links knows how to read them back. A
 * module that has a kind of subject puts a command named `subject-<kind>` on `PATH`; `search`
 * runs `JSON_OUTPUT=1 subject-<kind> <ref>...` and orders, intersects, pages and counts the answer
 * itself, and `JSON_OUTPUT=1 subject-<kind> --of <file>` for the subjects a set of media has.
 *
 * Imports nothing, on purpose: these are part of the module contract (`@ein/client`), and
 * everything a contract type imports ships with the contract.
 */

/**
 * Media whose attr `attr` equals `value`: a subject the store can answer by itself, and page
 * however large it is. `search` pushes it into its store query where it can.
 */
export type SubjectMatch = { attr: string; value: string };

/** One ref as the command resolved it: its node, and its media as a set of ids or as a match. */
export type SubjectEntry = {
  /** The ref as it was asked: a slug, a name or a path, whatever the command accepts. */
  ref: string;
  /** The subject node's absolute path. Absent with `error`. */
  path?: string;
  /** The ids of the media files the subject has. */
  ids?: string[];
  /** Or, instead of `ids`: the attr equality that finds them. */
  match?: SubjectMatch;
  /** `ids` stops at the command's own ceiling; more media exists. */
  truncated?: boolean;
  /** Why the ref resolved to nothing, said so a person can act on it. */
  error?: string;
};

/** A subject command's whole answer: one entry per ref, in the order asked. */
export type SubjectListing = { subjects: SubjectEntry[] };

/**
 * `subject-<kind> --of <file>`: the subjects of `kind` each of a set of media has, which
 * `search --group-by <kind>` counts. The file holds the media ids as a JSON array.
 */
export type SubjectsOf = {
  /** Every subject the media have, once: its path, and its name — absent for one nobody has named yet. */
  subjects: { path: string; name?: string }[];
  /** Per media id that has any, the indexes in `subjects` of the ones it has. */
  media: Record<string, number[]>;
};
