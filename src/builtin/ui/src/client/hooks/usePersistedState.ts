import { useLocalStorage } from '@mantine/hooks';

/**
 * A piece of view state that survives navigation and reloads.
 *
 * Thin wrapper over Mantine's `useLocalStorage` so every persisted control uses
 * the same key namespace and the same "unset means the default" behaviour.
 */
export function usePersistedState<T extends string>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useLocalStorage<T>({ key: `ein.${key}`, defaultValue });
  return [value ?? defaultValue, setValue];
}
