import { useLocalStorage } from '@mantine/hooks';

/**
 * A piece of view state that survives navigation and reloads.
 *
 * Thin wrapper over Mantine's `useLocalStorage` so every persisted control uses
 * the same key namespace and the same "unset means the default" behaviour.
 *
 * The stored value is read on the first render, not in an effect after it: the UI is rendered
 * in the browser only, and a first render with the default would show it for a frame and hand
 * it to whatever is set up once from it, such as a player's starting volume.
 */
export function usePersistedState<T extends string>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useLocalStorage<T>({ key: `ein.${key}`, defaultValue, getInitialValueInEffect: false });
  return [value ?? defaultValue, setValue];
}
