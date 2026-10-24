import { useEffect, useRef, useSyncExternalStore } from 'react';
import { type CommandQueue, type CommandQueueItem, createCommandQueue } from '../lib/command-queue.ts';

export type { CommandQueueItem, CommandTask } from '../lib/command-queue.ts';

export type CommandQueueHandle = Pick<CommandQueue, 'enqueue' | 'cancel' | 'retry' | 'dismiss' | 'idle'> & {
  /** The tasks waiting, running and failed, oldest first. */
  items: readonly CommandQueueItem[];
  /** How many are waiting or running. */
  backlog: number;
};

/**
 * A page's serial queue of commands (`createCommandQueue`): what a decision drawn at once runs
 * behind it, one command at a time and in order. While anything is waiting or running, leaving or
 * reloading the page asks first, since what has not run yet would not run.
 */
export function useCommandQueue(): CommandQueueHandle {
  const queueRef = useRef<CommandQueue | null>(null);
  queueRef.current ??= createCommandQueue();
  const queue = queueRef.current;
  const items = useSyncExternalStore(queue.subscribe, queue.items);
  const backlog = items.filter((item) => item.state !== 'failed').length;

  useEffect(() => {
    if (backlog === 0) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when a message is set; none of them shows it.
      event.returnValue = '';
    };
    globalThis.addEventListener('beforeunload', guard);
    return () => globalThis.removeEventListener('beforeunload', guard);
  }, [backlog > 0]);

  return { enqueue: queue.enqueue, cancel: queue.cancel, retry: queue.retry, dismiss: queue.dismiss, idle: queue.idle, items, backlog };
}
