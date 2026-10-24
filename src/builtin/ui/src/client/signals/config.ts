import { signal } from '@preact/signals-react';
import { execCommand } from './shell-client.ts';
import type { ConfigEntry } from '@ein/api';
export type { ConfigEntry } from '@ein/api';

/**
 * This person's own settings, keyed by name.
 *
 * Loaded once when the shell connects and refreshed after a save, rather than
 * read where they are used: the lightbox would otherwise run a command every
 * time it opened, to answer a question whose answer changes about twice a year.
 */
export const userConfig = signal<Record<string, string>>({});

export async function loadUserConfig(): Promise<void> {
  try {
    const entries = await execCommand<ConfigEntry[]>('config list --scope user');
    userConfig.value = Object.fromEntries((entries ?? []).map((entry) => [entry.key, entry.value]));
  } catch {
    // A settings read that fails must not take the app down with it — every
    // consumer has a default, which is what an empty map gives them.
    userConfig.value = {};
  }
}

/** One setting as a number, falling back when it is unset or unparseable. */
export const userConfigNumber = (key: string, fallback: number): number => {
  const parsed = Number(userConfig.value[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** One setting as a boolean. Anything other than an explicit 'false' is on. */
export const userConfigFlag = (key: string, fallback: boolean): boolean => {
  const raw = userConfig.value[key];
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false';
};
