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

/** What `tar -x` answers in JSON: what it wrote where, the files it left as they were, and each entry or name it did not expand. */
export type TarAnswer = {
  ok: boolean;
  /** The archive's path, or `-` for stdin. */
  archive: string;
  /** The directory the entries were expanded into. */
  directory: string;
  /** Files written. */
  files: number;
  /** Directories made; those already there are not counted. */
  directories: number;
  /** Softlinks and hard links made. */
  links: number;
  /** Bytes written. */
  bytes: number;
  /** Files and links already there as the archive has them, left as they were. */
  skipped: number;
  /** Each entry not expanded, and each name given that no entry matched, with why. */
  failed: { entry: string; error: string }[];
};

/** One entry `tar -t` lists in JSON. */
export type TarListEntry = {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  /** A file's bytes; 0 for anything else. */
  size: number;
  /** Its permission bits, as a number. */
  mode: number;
  /** Its modification time, ISO 8601. */
  mtime: string;
  /** What a symlink points at, or the entry a hard link names. */
  linkname?: string;
};
