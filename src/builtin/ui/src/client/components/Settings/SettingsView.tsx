import { Alert, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconDeviceFloppy } from '@tabler/icons-react';
import { useState } from 'react';
import type { ConfigEntry, ConfigWriteAnswer } from '@ein/api';

/** What a write did, in a sentence or two: the services it restarted or failed to, and what takes effect later. */
export const writeNote = (answer: ConfigWriteAnswer): string | null => {
  const said = [
    ...(answer.restarted.length > 0 ? [`Restarted ${answer.restarted.join(', ')}.`] : []),
    ...answer.failed.map((failure) => `Could not restart ${failure.name}: ${failure.error}.`),
    ...answer.notes,
  ];
  return said.length > 0 ? said.join(' ') : null;
};

/** One setting of a table `useConfig` read, by key; undefined while it loads or when no module declares it. */
export const settingOf = (entries: ConfigEntry[], key: string): ConfigEntry | undefined => entries.find((entry) => entry.key === key);

/** A settings view's save in progress: whether one runs, what the last did, and why it failed. */
export type ViewSave = {
  busy: boolean;
  /** What the last save did (`writeNote`), or that it was saved. */
  note: string | null;
  error: string | null;
  /** Run `write` (`useConfig`'s `saveAll` or `resetAll`, or several of them), and say how it went; resolves with whether it did. */
  run: (write: () => Promise<ConfigWriteAnswer | ConfigWriteAnswer[]>) => Promise<boolean>;
  /** Forget the last note and error, as when the form is changed again. */
  clear: () => void;
};

/** A settings view's save: the state `SaveBar` shows, kept for a view that saves several settings as one. */
export function useViewSave(): ViewSave {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run: ViewSave['run'] = async (write) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const answers = [await write()].flat();
      const failed = answers.flatMap((answer) => answer.failed);
      const said = answers.map(writeNote).filter((text) => text !== null).join(' ');
      if (failed.length > 0) setError(said);
      else setNote(said || 'Saved.');
      return failed.length === 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, error, run, clear: () => (setNote(null), setError(null)) };
}

type SaveBarProps = {
  save: ViewSave;
  /** Whether the form differs from what is in force; Save and Cancel are offered only then. */
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
  /** Why it cannot be saved as it is, said beside a disabled Save. */
  blocked?: string;
};

/** A settings view's Save and Cancel, and under them what the last save did or why it failed. */
export function SaveBar({ save, dirty, onSave, onCancel, blocked }: SaveBarProps) {
  return (
    <>
      {dirty && (
        <Group justify='flex-end' gap='xs'>
          {blocked && <Text size='xs' c='dimmed'>{blocked}</Text>}
          <Button variant='subtle' disabled={save.busy} onClick={onCancel}>Cancel</Button>
          <Button loading={save.busy} disabled={Boolean(blocked)} leftSection={<IconDeviceFloppy size={16} />} onClick={onSave}>Save</Button>
        </Group>
      )}
      {save.note && <Text size='sm' c='dimmed'>{save.note}</Text>}
      {save.error && <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} p='xs'>{save.error}</Alert>}
    </>
  );
}
