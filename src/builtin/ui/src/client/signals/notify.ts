import { signal } from '@preact/signals-react';

/** A short message at the foot of the screen, with at most one action (Undo, Open). */
export type Toast = {
  id: number;
  message: string;
  color?: 'red' | 'green' | 'blue' | 'yellow' | 'gray';
  action?: { label: string; onClick: () => void };
  /** How far a long piece of work has come, 0 to 1: drawn as a bar under the message (`notifyProgress`). */
  progress?: number;
};

/** What is showing now, oldest first. */
export const toasts = signal<Toast[]>([]);

/** How long a toast stays; one with an action stays longer, so there is time to take it. */
const PLAIN_MS = 4000;
const ACTION_MS = 8000;

let nextId = 0;

/** Take a toast away before its time. */
export const dismissToast = (id: number): void => {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
};

/**
 * Say that something happened, at the foot of the screen, and offer the one thing worth doing about
 * it: "3 photos moved to trash · Undo". It leaves by itself; taking the action dismisses it.
 * @returns the toast's id, for `dismissToast`
 */
export function notify(toast: Omit<Toast, 'id'>): number {
  const id = ++nextId;
  const action = toast.action && {
    label: toast.action.label,
    onClick: () => {
      dismissToast(id);
      toast.action!.onClick();
    },
  };
  toasts.value = [...toasts.value, { ...toast, id, action }];
  globalThis.setTimeout(() => dismissToast(id), action ? ACTION_MS : PLAIN_MS);
  return id;
}

/** A toast that follows a long piece of work (`notifyProgress`). */
export type ProgressToast = {
  id: number;
  /** Change what it says, how far the bar is, or its action (null takes the action away). */
  update: (change: { message?: string; progress?: number; action?: Toast['action'] | null; color?: Toast['color'] }) => void;
  /** The work is over: the toast says how it ended, loses its bar, and leaves as `notify`'s do. */
  finish: (toast: Omit<Toast, 'id' | 'progress'>) => void;
  dismiss: () => void;
};

/**
 * Say how far a long piece of work has come — "Filing 1,840 of 9,830 photos · 37 of 214 groups" —
 * with a bar and one action (Cancel). It stays until `finish`, which turns it into an ordinary
 * toast (with Undo all, say) that leaves by itself; its action does not dismiss it, so Cancel can
 * say that it is stopping.
 */
export function notifyProgress(toast: Omit<Toast, 'id'> & { progress: number }): ProgressToast {
  const id = ++nextId;
  const put = (next: Toast) => {
    // Closed by hand, it stays closed; the work goes on.
    if (!toasts.peek().some((each) => each.id === id)) return;
    toasts.value = toasts.value.map((each) => each.id === id ? next : each);
  };
  let current: Toast = { ...toast, id };
  toasts.value = [...toasts.value, current];
  return {
    id,
    update: (change) => {
      const { action, ...rest } = change;
      current = { ...current, ...rest, ...(action === undefined ? {} : { action: action ?? undefined }) };
      put(current);
    },
    finish: (final) => {
      const action = final.action && {
        label: final.action.label,
        onClick: () => {
          dismissToast(id);
          final.action!.onClick();
        },
      };
      current = { ...final, id, action };
      if (toasts.peek().some((each) => each.id === id)) put(current);
      else toasts.value = [...toasts.value, current];
      globalThis.setTimeout(() => dismissToast(id), action ? ACTION_MS : PLAIN_MS);
    },
    dismiss: () => dismissToast(id),
  };
}
