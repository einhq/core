import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { Dialog, DialogActions } from '../../Surface/Dialog.tsx';
import { ModuleAvatar } from '../../Identity/ModuleAvatar.tsx';

/** One module an update puts in place: from what is installed to what it goes to, and what `mod install` is given for it. */
export type PlannedUpdate = { name: string; from: string | null; to: string; target: string };

/** Starts `mod install` of `targets` as one change, in the background; `force` installs past the ranges left unmet. Throws why it did not start. */
export const startUpdate = async (targets: string[], force: boolean): Promise<void> => {
  await execCommand(`mod install --background ${force ? '--force ' : ''}${targets.map(shq).join(' ')}`);
};

/** `a`, `a and b`, `a, b and c`. */
export const namesList = (names: string[]): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

type UpdateDialogProps = {
  opened: boolean;
  /** The modules asked for, by name: one for a module's Update, every one with a newer release for Update all. */
  asked: string[];
  /** Every module put in place: those asked for and those that go with them. */
  updates: PlannedUpdate[];
  /** Each range the update leaves unmet even so. */
  held: string[];
  onClose: () => void;
  /** After the install was started. */
  onStarted: () => void;
};

/**
 * What an update does before it is started, when that is more than the one module asked for: each
 * module it puts in place, from its version to the new one, with a warning naming those not asked
 * for and why they go too — the versions they ask of each other — and, when a range is left unmet
 * even so, what breaks, with Update anyway, which forces it.
 */
export function UpdateDialog({ opened, asked, updates, held, onClose, onStarted }: UpdateDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const extra = updates.filter((each) => !asked.includes(each.name)).map((each) => each.name);
  const forced = held.length > 0;

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await startUpdate(updates.map((each) => each.target), forced);
      onClose();
      onStarted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={() => {
        if (busy) return;
        setProblem(null);
        onClose();
      }}
      title={updates.length === 1 ? `Update ${updates[0].name}?` : `Update ${updates.length} modules?`}
      icon='refresh'
      pattern={forced ? 'danger' : undefined}
      size='md'
      floating
    >
      <Stack gap='sm'>
        {extra.length > 0 && (
          <Alert color='yellow' variant='light' p='xs' icon={<IconAlertTriangle size={16} />} title='More than you asked for is updated'>
            <Text size='sm'>
              {namesList(extra)} {extra.length > 1 ? 'are' : 'is'} updated too: the versions {namesList(asked)} and {extra.length > 1 ? 'they' : 'it'}{' '}
              ask of each other hold only when they are updated together.
            </Text>
          </Alert>
        )}
        <Stack gap={6}>
          {updates.map((each) => (
            <Group key={each.name} gap='sm' wrap='nowrap'>
              <ModuleAvatar name={each.name} size={24} />
              <Text size='sm' fw={600} style={{ flex: 1, minWidth: 0 }} truncate>{each.name}</Text>
              <Text size='sm' ff='monospace' c='dimmed' style={{ flex: 'none' }}>{each.from ?? '—'} → {each.to}</Text>
            </Group>
          ))}
        </Stack>
        {forced && (
          <Alert color='red' variant='light' p='xs' icon={<IconAlertTriangle size={16} />} title='Some modules will stop working'>
            <List size='sm' spacing={4}>
              {held.map((why) => <List.Item key={why}>{why}</List.Item>)}
            </List>
            <Text size='sm' mt='xs'>Updating anyway leaves their setup failing until they have a release that accepts it.</Text>
          </Alert>
        )}
        <Text size='sm' c='dimmed'>The install goes on when this page is closed; what depends on an updated module is set up again.</Text>
        {problem && (
          <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />}>
            <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
          </Alert>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' disabled={busy} onClick={onClose}>Cancel</Button>
        <Button color={forced ? 'red' : undefined} leftSection={<IconRefresh size={16} />} loading={busy} onClick={start}>
          {forced ? 'Update anyway' : updates.length === 1 ? 'Update' : `Update ${updates.length} modules`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
