/**
 * One row of the trash, as `trash` answers: a trashed node, what it was, where it came from and
 * where it is now; or a batch of them trashed together (`type: 'batch'`).
 */
export type TrashEntry = {
  /**
   * What `trash restore` and `trash empty` take: the entry's directory in the trash, a batch's own,
   * or `<batch>/<entry>` for one entry of a batch.
   */
  id: string;
  /** The trashed node's own name; a batch's label, or its id when it has none. */
  name: string;
  /** Where it was when it was trashed, and where `trash restore` puts it back; empty for a batch. */
  origPath: string;
  /** Where it is now, inside the trash; it opens there as before. A batch's is its directory. */
  path: string;
  trashedAt: string;
  /** The trashed node's type, or `'batch'`. */
  type: string;
  mimetype?: string;
  /** A batch's: how many entries it holds. */
  count?: number;
  /** A batch's: what it is called (`trash put --batch --label`). */
  label?: string;
};

/** `trash put`: the entries just made, and with `--batch` the batch they went into. */
export type TrashPutResult = { entries: TrashEntry[]; batch?: string };

/**
 * `trash restore`: where each entry went back to — its old path, or a numbered name beside it —
 * and, when a batch was named, how many entries are left in the batches named.
 */
export type TrashRestoreResult = { restored: { id: string; path: string }[]; remaining?: number };
