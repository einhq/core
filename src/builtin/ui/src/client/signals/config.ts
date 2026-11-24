import { signal } from '@preact/signals-react';
import { execCommand } from './shell-client.ts';
import { type ConfigEntry, type MapPosition, parseMapPosition } from '@ein/api';
export type { ConfigEntry } from '@ein/api';

/**
 * This person's own settings, keyed by name.
 *
 * Loaded once when the shell connects and refreshed after a save, rather than
 * read where they are used: the lightbox would otherwise run a command every
 * time it opened, to answer a question whose answer changes about twice a year.
 */
export const userConfig = signal<Record<string, string>>({});

/** `CFG_TIME_LOCALE`'s default, for a browser whose settings did not load. */
const DEFAULT_TIME_LOCALE = 'sv-SE';

/**
 * The locale dates and times are written in: this person's `CFG_USER_TIME_LOCALE`, else the
 * system's `CFG_TIME_LOCALE`. Read through `formatDateTime` and its siblings in `@ein/ui/lib`.
 */
export const timeLocale = signal(DEFAULT_TIME_LOCALE);

/** `CFG_MAP_CENTER`'s default, for a browser whose settings did not load. */
const DEFAULT_MAP_HOME: MapPosition = { lat: 51.5074, lng: -0.1278, zoom: 11 };

/**
 * Where a map opens when it is given no place of its own: this person's `CFG_USER_MAP_CENTER`,
 * else the system's `CFG_MAP_CENTER`.
 */
export const mapHome = signal<MapPosition>(DEFAULT_MAP_HOME);

/** Whether `Intl` formats in `locale`; a value written into `.config` by hand is not checked. */
const knownLocale = (locale: string | undefined): locale is string => {
  if (!locale) return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0;
  } catch {
    return false;
  }
};

export async function loadUserConfig(): Promise<void> {
  try {
    const entries = await execCommand<ConfigEntry[]>('config list');
    userConfig.value = Object.fromEntries((entries ?? []).filter((entry) => entry.scope === 'user').map((entry) => [entry.key, entry.value]));
    const system = entries?.find((entry) => entry.key === 'CFG_TIME_LOCALE')?.value;
    timeLocale.value = [userConfig.value.CFG_USER_TIME_LOCALE, system].find(knownLocale) ?? DEFAULT_TIME_LOCALE;
    const systemMap = entries?.find((entry) => entry.key === 'CFG_MAP_CENTER')?.value ?? '';
    mapHome.value = parseMapPosition(userConfig.value.CFG_USER_MAP_CENTER ?? '') ?? parseMapPosition(systemMap) ?? DEFAULT_MAP_HOME;
  } catch {
    // A settings read that fails must not take the app down with it — every
    // consumer has a default, which is what an empty map gives them.
    userConfig.value = {};
    timeLocale.value = DEFAULT_TIME_LOCALE;
    mapHome.value = DEFAULT_MAP_HOME;
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
