/**
 * A serial queue of commands a page runs on behalf of decisions it has already drawn: each task
 * runs after the one before it has settled, in the order given, so commands that touch the same
 * things never race and an undo always follows what it undoes. Pure: the hook `useCommandQueue`
 * holds one per page.
 *
 * A task waits `queued`, then is `running`; one that succeeds leaves the queue, and one that fails
 * stays `failed` until it is retried (queued again at the end) or dismissed. One still queued can
 * be cancelled, which runs nothing. A task's own callbacks say how it ended, so the page can keep
 * what it drew or take it back.
 */

type CommandTaskState = 'queued' | 'running' | 'failed';

/** What a page hands the queue: what to run, what to call it, and what to do as it ends. */
export type CommandTask<T = unknown> = {
  /** What a progress line or a failure calls it: "Filing 143 photos in Lake trip 2019". */
  label: string;
  run: () => Promise<T>;
  onDone?: (result: T) => void;
  onFail?: (error: Error) => void;
  /** It was cancelled before it ran. */
  onCancel?: () => void;
};

/** A task as the queue shows it. */
export type CommandQueueItem = { id: number; label: string; state: CommandTaskState; error?: Error };

export type CommandQueue = {
  /** Add a task at the end; it runs once every task before it has settled. */
  enqueue: <T>(task: CommandTask<T>) => number;
  /** Cancel a task that has not started. False when it has (or is not there). */
  cancel: (id: number) => boolean;
  /** Queue a failed task again, at the end. */
  retry: (id: number) => boolean;
  /** Forget a failed task. */
  dismiss: (id: number) => void;
  /** The tasks not yet forgotten, oldest first: those waiting, the one running, those that failed. */
  items: () => readonly CommandQueueItem[];
  /** How many are waiting or running. */
  backlog: () => number;
  /** Be told whenever an item changes; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Resolves once nothing is waiting or running. */
  idle: () => Promise<void>;
};

type Entry = CommandQueueItem & { task: CommandTask<unknown> };

const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

export function createCommandQueue(): CommandQueue {
  let entries: Entry[] = [];
  let snapshot: readonly CommandQueueItem[] = [];
  let nextId = 0;
  let running = false;
  const listeners = new Set<() => void>();
  let waiters: (() => void)[] = [];

  const backlog = () => entries.filter((entry) => entry.state === 'queued' || entry.state === 'running').length;
  const changed = () => {
    snapshot = entries.map(({ id, label, state, error }) => ({ id, label, state, ...(error ? { error } : {}) }));
    for (const listener of listeners) listener();
    if (backlog() === 0) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    }
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      for (let entry = entries.find((each) => each.state === 'queued'); entry; entry = entries.find((each) => each.state === 'queued')) {
        entry.state = 'running';
        changed();
        try {
          const result = await entry.task.run();
          entries = entries.filter((each) => each !== entry);
          changed();
          entry.task.onDone?.(result);
        } catch (error) {
          entry.state = 'failed';
          entry.error = asError(error);
          changed();
          entry.task.onFail?.(entry.error);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    enqueue: <T>(task: CommandTask<T>) => {
      const id = ++nextId;
      entries = [...entries, { id, label: task.label, state: 'queued', task: task as CommandTask<unknown> }];
      changed();
      void pump();
      return id;
    },
    cancel: (id) => {
      const entry = entries.find((each) => each.id === id);
      if (entry?.state !== 'queued') return false;
      entries = entries.filter((each) => each !== entry);
      changed();
      entry.task.onCancel?.();
      return true;
    },
    retry: (id) => {
      const entry = entries.find((each) => each.id === id);
      if (entry?.state !== 'failed') return false;
      entries = [...entries.filter((each) => each !== entry), { ...entry, state: 'queued', error: undefined }];
      changed();
      void pump();
      return true;
    },
    dismiss: (id) => {
      const before = entries.length;
      entries = entries.filter((each) => each.id !== id || each.state === 'queued' || each.state === 'running');
      if (entries.length !== before) changed();
    },
    items: () => snapshot,
    backlog,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    idle: () => backlog() === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
  };
}
