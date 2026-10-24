/** One node `find` matched, as it answers in JSON. */
export type FindEntry = {
  path: string;
  type: string;
  name: string;
  /** How many children it has: whether there is anything below it to open. */
  childCount: number;
};

/** What `mv` answers in JSON: how many sources moved, the links it re-pointed, and each source that did not move. */
export type MvAnswer = {
  ok: boolean;
  moved: number;
  /** Softlinks re-pointed at the new paths: those at a moved path or anywhere under it. */
  relinked: number;
  failed: { path: string; error: string }[];
};

/** What `unzip` answers in JSON: what it wrote where, the files it left as they were, and each entry it did not expand. */
export type UnzipAnswer = {
  ok: boolean;
  /** The archive's path. */
  archive: string;
  /** The directory the entries were expanded into. */
  directory: string;
  /** Files written. */
  files: number;
  /** Directories made; those already there are not counted. */
  directories: number;
  /** Uncompressed bytes written. */
  bytes: number;
  /** Files already there at their entry's size, left as they were. */
  skipped: number;
  failed: { entry: string; error: string }[];
};
