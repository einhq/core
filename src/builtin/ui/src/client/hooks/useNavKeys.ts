import { useHotkeys } from '@mantine/hooks';
import { matchedPhysically, typedInFields } from '../signals/shortcuts.ts';

/** A navigation entry's key (`alt+P`, Mantine's hotkey form) and what pressing it does. */
type NavKey = [keys: string, run: () => void];

const TEXT_FIELDS = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * Bind the sidebar's and the top bar's keys. An Alt+letter is matched by the key's place, and
 * acts from a text field too, where it types nothing (`typedInFields`); a list page that puts the
 * focus in its filter box would otherwise hold every page key. Any other key is the field's there.
 */
export function useNavKeys(keys: NavKey[]): void {
  const bind = (inFields: boolean) =>
    keys
      .filter(([shortcut]) => typedInFields(shortcut) !== inFields)
      .map(([shortcut, run]): [string, () => void, { preventDefault: boolean; usePhysicalKeys: boolean }] => [
        shortcut,
        run,
        { preventDefault: true, usePhysicalKeys: matchedPhysically(shortcut) },
      ]);
  useHotkeys(bind(true), []);
  useHotkeys(bind(false), TEXT_FIELDS);
}
