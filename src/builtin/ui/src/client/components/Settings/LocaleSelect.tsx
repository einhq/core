import { Select } from '@mantine/core';
import { useMemo } from 'react';

/** The locales offered by name: Sweden's, its neighbours' and the larger European and English ones. */
const LOCALES = ['sv-SE', 'en-SE', 'en-GB', 'en-IE', 'en-US', 'da-DK', 'nb-NO', 'fi-FI', 'de-DE', 'de-CH', 'nl-NL', 'fr-FR', 'es-ES', 'it-IT', 'pl-PL'];

/** How `locale` writes a moment as a date and time and as a date in words: `2026-11-14 13:26 · 14 nov. 2026` in `sv-SE`. */
export const localeSample = (locale: string, at: Date = new Date()): string => {
  try {
    const short = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).format(at);
    const long = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(at);
    return `${short} · ${long}`;
  } catch {
    return '';
  }
};

/** A locale's name in English: `Swedish (Sweden)`, or the tag itself when the browser has no name for it. */
const localeName = (locale: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
};

type LocaleSelectProps = {
  id?: string;
  label?: string;
  description?: string;
  value: string;
  onChange: (locale: string) => void;
  disabled?: boolean;
  /** What no locale means, for a setting that may be left empty; absent, one must be chosen. */
  emptyMeans?: string;
};

/**
 * A date and time format, chosen as a locale by name with how it writes now beside it. The value
 * in force is offered too when it is none of the usual ones; any other is set in the settings
 * list, as a locale tag.
 */
export function LocaleSelect({ id, label, description, value, onChange, disabled, emptyMeans }: LocaleSelectProps) {
  const data = useMemo(() => {
    const now = new Date();
    return [...new Set([...(value && !LOCALES.includes(value) ? [value] : []), ...LOCALES])].map((locale) => ({
      value: locale,
      label: `${localeName(locale)} — ${localeSample(locale, now)}`,
    }));
  }, [value]);
  return (
    <Select
      id={id}
      label={label}
      description={description}
      data={data}
      value={value || null}
      disabled={disabled}
      searchable
      clearable={emptyMeans !== undefined}
      allowDeselect={false}
      placeholder={emptyMeans ? `Empty means ${emptyMeans}` : undefined}
      nothingFoundMessage='No such locale here; set another in the list of all settings'
      onChange={(next) => onChange(next ?? '')}
    />
  );
}
