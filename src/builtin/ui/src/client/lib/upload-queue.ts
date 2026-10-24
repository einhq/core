/**
 * The upload queue's bookkeeping, apart from the browser: files queued into a target directory,
 * keeping the folders they were dropped or picked in when asked to; the directories they need,
 * made with one `mkdir -p` for up to 100 of them; at most four files sent at once; and counters
 * kept as each file moves on, so a progress event costs the same at five files as at five
 * thousand. Pure: `signals/upload.ts` gives it the sending, the `mkdir` and the signals the counts
 * are shown through.
 *
 * Each `add` is a batch, with its own counters; a target's summary sums its batches', and the
 * whole queue's sums them all, so neither ever walks the files.
 */

/** Files sent at once. */
const UPLOAD_WORKERS = 4;
/** Directories one `mkdir -p` makes at most. */
const MKDIR_CHUNK = 100;
/** Failures kept to be listed; every failed file is still counted and retried. */
const FAILURES_KEPT = 200;

/** An upload's directory: a path, or what makes the directory once the first file is sent and answers its path. */
export type UploadTarget = string | (() => Promise<string>);

export type UploadOptions = {
  /**
   * Keep the folders the files were in: each goes into the target plus the folders of its path
   * relative to what was dropped or picked (`relativePath`, `webkitRelativePath`). Otherwise
   * every file goes straight into the target.
   */
  keepFolders?: boolean;
  /** What a progress list calls the target; its directory's own name otherwise. */
  label?: string;
};

/**
 * Where files stand. `queued` wait, `active` are being sent (or their directory made), `done`
 * were stored, `renamed` of them under a numbered name because theirs was taken, `failed` did
 * not make it. `bytesTotal` counts the queued, active and stored files, `bytesDone` the stored
 * ones and what was sent of the active.
 */
export type UploadCounts = {
  queued: number;
  active: number;
  done: number;
  failed: number;
  renamed: number;
  bytesTotal: number;
  bytesDone: number;
};

/** The counts of the files queued into one target directory, and what to call it. */
export type UploadTargetSummary = UploadCounts & { label: string };

/** A file being sent: into which directory, how big, how much has gone. */
export type UploadInFlight = { name: string; dir: string; size: number; sent: number };

/** A file that did not make it, and why. `dir` is where it was going. */
export type UploadFailure = { name: string; dir: string; error: string };

/** What the queue reads of a file: a browser `File`, with the path a drop or a folder picker gave it. */
export type UploadFile = { readonly name: string; readonly size: number; readonly relativePath?: string; readonly webkitRelativePath?: string };

/** No files anywhere. */
export const NO_UPLOADS: UploadCounts = { queued: 0, active: 0, done: 0, failed: 0, renamed: 0, bytesTotal: 0, bytesDone: 0 };

/** Files counted in `counts`, whatever became of them. */
export const uploadFiles = (counts: UploadCounts): number => counts.queued + counts.active + counts.done + counts.failed;

/**
 * The folders `file` was in below what was dropped or picked, `a/b`, or empty for a file that
 * was not in one. A dropped folder's files name them from a leading `/` (`/a/b/x.jpg`), a picked
 * folder's without (`a/b/x.jpg`), a lone file as `./x.jpg`; empty and `.` segments are skipped,
 * and a `..` is refused, as a path that would leave the target.
 */
export const folderOf = (file: UploadFile): string => {
  const path = file.relativePath || file.webkitRelativePath || '';
  const segments = path.split('/').slice(0, -1).filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new Error(`refused folder in ${path}`);
  return segments.join('/');
};

/** `dirs` without the ones another of them lies under, which `mkdir -p` of that one makes anyway. */
export const leafDirs = (dirs: Iterable<string>): string[] => {
  const unique = [...new Set(dirs)];
  const above = new Set<string>();
  for (const dir of unique) {
    for (let at = dir.lastIndexOf('/'); at > 0; at = dir.lastIndexOf('/', at - 1)) above.add(dir.slice(0, at));
    if (dir !== '/') above.add('/');
  }
  return unique.filter((dir) => !above.has(dir));
};

/**
 * The counts of the targets at or under `path`, summed; undefined when there are none. A staging
 * category's uploads go into a folder of the day under it, so its card sums what is under it.
 */
export const uploadsUnder = (byTarget: Readonly<Record<string, UploadTargetSummary>>, path: string): UploadCounts | undefined => {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  let sum: UploadCounts | undefined;
  for (const [root, counts] of Object.entries(byTarget)) {
    if (root !== path && !root.startsWith(prefix)) continue;
    sum ??= { ...NO_UPLOADS };
    for (const key of Object.keys(NO_UPLOADS) as (keyof UploadCounts)[]) sum[key] += counts[key];
  }
  return sum;
};

const withoutSlash = (dir: string): string => dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;

/** `rel` (folders below a target) under `root`. */
const joinDir = (root: string, rel: string): string => rel === '' ? root : root === '/' ? `/${rel}` : `${root}/${rel}`;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** What the queue asks of its surroundings. */
type UploadQueueIo<F extends UploadFile> = {
  /**
   * Store `file` in `dir` and answer the path it was stored at, calling `progress` with the bytes
   * sent so far. Rejects when it fails, and when `signal` aborts it.
   */
  send: (file: F, dir: string, progress: (sent: number) => void, signal: AbortSignal) => Promise<string>;
  /** Make the directories `dirs`, with their parents. */
  mkdir: (dirs: string[]) => Promise<void>;
  /** Something counted changed. Called on every change; the caller decides how often to look. */
  changed: () => void;
  /** Nothing is queued or being sent any more; `roots` are the targets that took a file since it last was so. */
  drained: (roots: string[]) => void;
};

type UploadQueueSettings = { workers?: number; mkdirChunk?: number; failuresKept?: number };

type UploadQueue<F extends UploadFile> = {
  /** Queue `files` into `target`. */
  add: (files: F[], target: UploadTarget, options?: UploadOptions) => void;
  /** Every file queued since the last `clear`. */
  summary: () => UploadCounts;
  /** The same, by target directory: those whose directory is known. */
  byTarget: () => Record<string, UploadTargetSummary>;
  /** The files being sent. */
  active: () => UploadInFlight[];
  /** The last failures, oldest first. */
  failures: () => UploadFailure[];
  /** Stop: the files being sent are aborted, and the queued ones dropped. */
  cancel: () => void;
  /** Queue the failed files again, at the end. A file whose folder was refused stays failed. */
  retry: () => void;
  /** Forget the files that are done or failed. */
  clear: () => void;
};

type Counts = UploadCounts & { storedBytes: number };

/** A directory a batch's files go into, by its folders below the target. */
type Dir = { rel: string; state: 'pending' | 'making' | 'ready' | 'failed'; made?: Promise<void> };

type Batch = {
  target: UploadTarget;
  label?: string;
  /** The target directory, once known. */
  root?: string;
  resolving?: Promise<string>;
  dirs: Map<string, Dir>;
  /** The directories in the order their first file was queued, and how far `mkdir` has taken them. */
  order: Dir[];
  dirCursor: number;
  counts: Counts;
};

type ItemState = 'queued' | 'active' | 'done' | 'failed' | 'cancelled';

type Item<F> = { file: F; batch: Batch; dir?: Dir; state: ItemState; sent: number; abort?: AbortController };

const READY: Promise<void> = Promise.resolve();

export function createUploadQueue<F extends UploadFile>(io: UploadQueueIo<F>, settings: UploadQueueSettings = {}): UploadQueue<F> {
  const workers = settings.workers ?? UPLOAD_WORKERS;
  const mkdirChunk = settings.mkdirChunk ?? MKDIR_CHUNK;
  const failuresKept = settings.failuresKept ?? FAILURES_KEPT;

  let batches: Batch[] = [];
  /** Append-only until the queue drains; `cursor` is the next one to start. */
  let items: Item<F>[] = [];
  let cursor = 0;
  const inFlight = new Set<Item<F>>();
  let failedItems: Item<F>[] = [];
  let failures: UploadFailure[] = [];
  const landed = new Set<string>();

  const where = (item: Item<F>): string => item.batch.root !== undefined ? joinDir(item.batch.root, item.dir?.rel ?? '') : item.batch.label ?? '';

  const recordFailure = (item: Item<F>, error: string) => {
    failures.push({ name: item.file.name, dir: where(item), error });
    if (failures.length > failuresKept) failures.shift();
  };

  const rootOf = (batch: Batch): Promise<string> => {
    if (batch.root !== undefined) return Promise.resolve(batch.root);
    const target = batch.target as () => Promise<string>;
    batch.resolving ??= target().then((dir) => batch.root = withoutSlash(dir));
    return batch.resolving;
  };

  /** Every directory of `batch` above `rel` is made along with it. */
  const madeAbove = (batch: Batch, rel: string) => {
    if (rel === '') return;
    const parts = rel.split('/');
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const above = batch.dirs.get(parts.slice(0, depth).join('/'));
      if (above?.state === 'pending') Object.assign(above, { state: 'ready', made: READY });
    }
  };

  /** `first` and the next pending directories of its batch, up to a chunk, made with one `mkdir`. */
  const makeChunk = (batch: Batch, root: string, first: Dir) => {
    const chunk = [first];
    while (chunk.length < mkdirChunk && batch.dirCursor < batch.order.length) {
      const next = batch.order[batch.dirCursor++];
      if (next.state === 'pending' && next !== first) chunk.push(next);
    }
    const made = io.mkdir(leafDirs(chunk.map((dir) => joinDir(root, dir.rel)))).then(() => {
      for (const dir of chunk) {
        dir.state = 'ready';
        madeAbove(batch, dir.rel);
      }
    }, (error) => {
      for (const dir of chunk) dir.state = 'failed';
      throw error;
    });
    // A chunk's other directories may have no file waiting on them yet.
    made.catch(() => {});
    for (const dir of chunk) Object.assign(dir, { state: 'making', made });
  };

  const ensureDir = (batch: Batch, root: string, dir: Dir): Promise<void> => {
    if (dir.state === 'pending') makeChunk(batch, root, dir);
    return dir.made!;
  };

  const progress = (item: Item<F>, sent: number) => {
    if (item.state !== 'active') return;
    const bounded = Math.min(Math.max(sent, 0), item.file.size);
    item.batch.counts.bytesDone += bounded - item.sent;
    item.sent = bounded;
    io.changed();
  };

  const finish = (item: Item<F>, root: string, dir: string, stored: string) => {
    const counts = item.batch.counts;
    const size = item.file.size;
    counts.active--;
    counts.done++;
    counts.bytesDone += size - item.sent;
    counts.storedBytes += size;
    if (stored !== joinDir(dir, item.file.name)) counts.renamed++;
    item.sent = size;
    item.state = 'done';
    landed.add(root);
    io.changed();
  };

  const fail = (item: Item<F>, error: string) => {
    const counts = item.batch.counts;
    counts.active--;
    counts.failed++;
    counts.bytesDone -= item.sent;
    counts.bytesTotal -= item.file.size;
    item.sent = 0;
    item.state = 'failed';
    failedItems.push(item);
    recordFailure(item, error);
    io.changed();
  };

  const run = async (item: Item<F>) => {
    const { batch } = item;
    item.state = 'active';
    batch.counts.queued--;
    batch.counts.active++;
    inFlight.add(item);
    io.changed();
    try {
      const root = await rootOf(batch);
      if (item.state !== 'active') return;
      await ensureDir(batch, root, item.dir!);
      if (item.state !== 'active') return;
      const dir = joinDir(root, item.dir!.rel);
      item.abort = new AbortController();
      const stored = await io.send(item.file, dir, (sent) => progress(item, sent), item.abort.signal);
      if (item.state === 'active') finish(item, root, dir, stored);
    } catch (error) {
      if (item.state === 'active') fail(item, messageOf(error));
    } finally {
      inFlight.delete(item);
      item.abort = undefined;
      pump();
    }
  };

  const pump = () => {
    while (inFlight.size < workers && cursor < items.length) {
      const item = items[cursor++];
      if (item.state === 'queued') void run(item);
    }
    if (inFlight.size > 0 || cursor < items.length || items.length === 0) return;
    items = [];
    cursor = 0;
    const roots = [...landed];
    landed.clear();
    io.drained(roots);
  };

  const add = (files: F[], target: UploadTarget, options: UploadOptions = {}) => {
    if (files.length === 0) return;
    const batch: Batch = {
      target,
      ...(options.label ? { label: options.label } : {}),
      ...(typeof target === 'string' ? { root: withoutSlash(target) } : {}),
      dirs: new Map(),
      order: [],
      dirCursor: 0,
      counts: { ...NO_UPLOADS, storedBytes: 0 },
    };
    batches.push(batch);
    for (const file of files) {
      const item: Item<F> = { file, batch, state: 'queued', sent: 0 };
      let rel = '';
      try {
        if (options.keepFolders) rel = folderOf(file);
      } catch (error) {
        item.state = 'failed';
        batch.counts.failed++;
        recordFailure(item, messageOf(error));
        continue;
      }
      let dir = batch.dirs.get(rel);
      if (!dir) {
        dir = { rel, state: 'pending' };
        batch.dirs.set(rel, dir);
        batch.order.push(dir);
      }
      item.dir = dir;
      batch.counts.queued++;
      batch.counts.bytesTotal += file.size;
      items.push(item);
    }
    io.changed();
    pump();
  };

  const summary = (): UploadCounts => {
    const sum = { ...NO_UPLOADS };
    for (const batch of batches) for (const key of Object.keys(NO_UPLOADS) as (keyof UploadCounts)[]) sum[key] += batch.counts[key];
    return sum;
  };

  const byTarget = (): Record<string, UploadTargetSummary> => {
    const out: Record<string, UploadTargetSummary> = {};
    for (const batch of batches) {
      if (batch.root === undefined) continue;
      const entry = out[batch.root] ??= { ...NO_UPLOADS, label: batch.label ?? (batch.root.split('/').filter(Boolean).pop() ?? batch.root) };
      for (const key of Object.keys(NO_UPLOADS) as (keyof UploadCounts)[]) entry[key] += batch.counts[key];
    }
    return out;
  };

  const active = (): UploadInFlight[] =>
    [...inFlight].filter((item) => item.state === 'active').map((item) => ({ name: item.file.name, dir: where(item), size: item.file.size, sent: item.sent }));

  const cancel = () => {
    for (const item of inFlight) {
      if (item.state !== 'active') continue;
      const counts = item.batch.counts;
      counts.active--;
      counts.bytesTotal -= item.file.size;
      counts.bytesDone -= item.sent;
      item.state = 'cancelled';
      item.abort?.abort();
    }
    for (let i = cursor; i < items.length; i++) {
      const item = items[i];
      if (item.state !== 'queued') continue;
      item.batch.counts.queued--;
      item.batch.counts.bytesTotal -= item.file.size;
      item.state = 'cancelled';
    }
    cursor = items.length;
    io.changed();
    pump();
  };

  const retry = () => {
    const again = failedItems;
    failedItems = [];
    if (again.length === 0) return;
    for (const item of again) {
      const { batch } = item;
      if (batch.root === undefined) batch.resolving = undefined;
      if (item.dir?.state === 'failed') {
        Object.assign(item.dir, { state: 'pending', made: undefined });
        batch.dirCursor = 0;
      }
      batch.counts.failed--;
      batch.counts.queued++;
      batch.counts.bytesTotal += item.file.size;
      item.state = 'queued';
      items.push(item);
    }
    failures = [];
    io.changed();
    pump();
  };

  const clear = () => {
    failedItems = [];
    failures = [];
    for (const batch of batches) {
      const counts = batch.counts;
      counts.bytesTotal -= counts.storedBytes;
      counts.bytesDone -= counts.storedBytes;
      Object.assign(counts, { storedBytes: 0, done: 0, failed: 0, renamed: 0 });
    }
    batches = batches.filter((batch) => batch.counts.queued + batch.counts.active > 0);
    io.changed();
  };

  return { add, summary, byTarget, active, failures: () => [...failures], cancel, retry, clear };
}
