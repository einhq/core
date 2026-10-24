import { signal } from '@preact/signals-react';
import type { StarEntry } from '@ein/api';
import { shq } from '../lib/shquote.ts';
import { execCommand } from './shell-client.ts';

/** What the reader has starred (`star list`): their favourites, by the path each points at. */
export const starredPaths = signal<ReadonlySet<string>>(new Set());

let loading: Promise<void> | null = null;

/** Read the reader's stars once; later calls wait on the same read. */
export function loadStars(): Promise<void> {
  loading ??= execCommand<StarEntry[]>('star list')
    .then((entries) => {
      starredPaths.value = new Set((entries ?? []).map((entry) => entry.target));
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

/**
 * Star or unstar `paths` in one `star` call. The set changes at once and goes back if the call
 * fails, so a heart answers the click rather than the round trip.
 */
export async function setStarred(paths: readonly string[], on: boolean): Promise<void> {
  const before = starredPaths.value;
  const changing = paths.filter((path) => before.has(path) !== on);
  if (changing.length === 0) return;

  const next = new Set(before);
  for (const path of changing) {
    if (on) next.add(path);
    else next.delete(path);
  }
  starredPaths.value = next;
  try {
    await execCommand(`star ${on ? '' : '-d '}${changing.map(shq).join(' ')}`);
  } catch (error) {
    starredPaths.value = before;
    throw error;
  }
}
