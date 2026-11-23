/**
 * The answers to reads this device keeps, to show while EiN is out of reach (ein/core#1522).
 *
 * An answer is kept by its command line, with when it was read, only when the API shell marked it a
 * read (`read` on its result) and only once the page knows it reads for someone signed in
 * (`keepAnswers`); until then answers wait in memory. Up to `ANSWERS_BUDGET` bytes are kept, the
 * answers read longest ago going first. They live in IndexedDB, so they outlast the page; the
 * reader they are kept for is stored beside them, and `forgetAnswers` empties the store for another.
 *
 * Every call is quiet when IndexedDB cannot be opened: nothing is kept, and nothing is found.
 */

const DB_NAME = 'ein-offline';
const DB_VERSION = 1;
/** The answers by command line: `{ command, data }`. */
const ANSWERS = 'answers';
/** When each answer was read and how large it is, by command line, indexed by `at`: small, so it is what pruning walks. */
const KEPT = 'kept';
/** Whom the store is kept for, under `READER`. */
const META = 'meta';
const READER = 'reader';

/** How many bytes of answers are kept, counted as the server sent them. */
const ANSWERS_BUDGET = 32 * 1024 * 1024;

/** How long answers wait to be written together, in one transaction. */
const WRITE_AFTER_MS = 1000;
/** How often the oldest answers past the budget are dropped, at most. */
const PRUNE_EVERY_MS = 60_000;

type SavedAnswer = { data: unknown; at: number };

type Kept = { command: string; at: number; size: number };

let database: Promise<IDBDatabase | null> | null = null;

const opened = (): Promise<IDBDatabase | null> =>
  database ??= new Promise<IDBDatabase | null>((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(ANSWERS, { keyPath: 'command' });
      db.createObjectStore(KEPT, { keyPath: 'command' }).createIndex('at', 'at');
      db.createObjectStore(META);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer page wants another version: let it, and open again when next asked.
      db.onversionchange = () => {
        db.close();
        database = null;
      };
      resolve(db);
    };
    request.onerror = () => resolve(null);
  });

const completed = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const answered = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Whether answers are kept on this page; undecided until the page knows who reads. */
let keep: boolean | undefined;
/** Answers read and not yet written, by command line. */
const waiting = new Map<string, Kept & { data: unknown }>();
let writeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let prunedAt = 0;

/** Drop what is kept past `ANSWERS_BUDGET`, the answers read longest ago first. */
const prune = async (db: IDBDatabase): Promise<void> => {
  prunedAt = Date.now();
  const tx = db.transaction([ANSWERS, KEPT], 'readwrite');
  const answers = tx.objectStore(ANSWERS);
  const cursor = tx.objectStore(KEPT).index('at').openCursor(null, 'prev');
  let total = 0;
  cursor.onsuccess = () => {
    const at = cursor.result;
    if (!at) return;
    const { command, size } = at.value as Kept;
    total += size;
    if (total > ANSWERS_BUDGET) {
      at.delete();
      answers.delete(command);
    }
    at.continue();
  };
  await completed(tx);
};

const writeWaiting = async (): Promise<void> => {
  writeTimer = undefined;
  const entries = [...waiting.values()];
  waiting.clear();
  const db = await opened();
  if (!db || entries.length === 0) return;
  try {
    const tx = db.transaction([ANSWERS, KEPT], 'readwrite');
    for (const { command, at, size, data } of entries) {
      tx.objectStore(ANSWERS).put({ command, data });
      tx.objectStore(KEPT).put({ command, at, size } satisfies Kept);
    }
    await completed(tx);
    if (Date.now() - prunedAt >= PRUNE_EVERY_MS) await prune(db);
  } catch (error) {
    // Out of room, most likely: what was kept before stays.
    console.warn('saved answers: not written', error);
  }
};

const scheduleWrite = (): void => {
  writeTimer ??= globalThis.setTimeout(() => void writeWaiting(), WRITE_AFTER_MS);
};

/** Keep an answer the server marked a read, `size` bytes as it arrived. */
export function saveAnswer(command: string, data: unknown, size: number): void {
  if (keep === false) return;
  waiting.set(command, { command, data, size, at: Date.now() });
  if (keep) scheduleWrite();
}

/** Keep the answers this page reads, those read before it was known too, or keep none of them. */
export function keepAnswers(on: boolean): void {
  keep = on;
  if (!on) waiting.clear();
  else if (waiting.size > 0) scheduleWrite();
}

/** The answer kept for `command`, with when it was read; undefined when there is none. */
export async function savedAnswer(command: string): Promise<SavedAnswer | undefined> {
  const db = await opened();
  if (!db) return undefined;
  try {
    const tx = db.transaction([ANSWERS, KEPT], 'readonly');
    const [answer, kept] = await Promise.all([
      answered<{ data: unknown } | undefined>(tx.objectStore(ANSWERS).get(command)),
      answered<Kept | undefined>(tx.objectStore(KEPT).get(command)),
    ]);
    return answer && kept ? { data: answer.data, at: kept.at } : undefined;
  } catch {
    return undefined;
  }
}

/** Whom the kept answers are for, as `forgetAnswers` last recorded; null for no one. */
export async function answersKeptFor(): Promise<string | null> {
  const db = await opened();
  if (!db) return null;
  try {
    return (await answered<string | null | undefined>(db.transaction(META, 'readonly').objectStore(META).get(READER))) ?? null;
  } catch {
    return null;
  }
}

/** Drop every kept answer, those waiting too, and record that what is kept from now on is `reader`'s. */
export async function forgetAnswers(reader: string | null): Promise<void> {
  waiting.clear();
  const db = await opened();
  if (!db) return;
  const tx = db.transaction([ANSWERS, KEPT, META], 'readwrite');
  tx.objectStore(ANSWERS).clear();
  tx.objectStore(KEPT).clear();
  tx.objectStore(META).put(reader, READER);
  await completed(tx);
}
