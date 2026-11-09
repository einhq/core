import { Alert, Button, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { DeviceInfo } from '@ein/api';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

type Props = {
  opened: boolean;
  onClose: () => void;
  info: DeviceInfo;
  /** After a save, so the page shows what was written. */
  onSaved: () => void;
};

/**
 * What a device and its endpoints are called on its pages and cards, edited in place: `device-label`
 * for the device and for each endpoint whose name changed. The names in `/dev`, which commands and
 * rules use, stay as they are. A retired endpoint is not offered.
 */
export function DeviceEditModal({ opened, onClose, info, onSaved }: Props) {
  const endpoints = info.endpointList.filter((endpoint) => !endpoint.retired);
  const [label, setLabel] = useState(info.label);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setLabel(info.label);
    setLabels(Object.fromEntries(endpoints.map((endpoint) => [endpoint.name, endpoint.label])));
    setError(null);
  }, [opened]);

  const changed: [string, string][] = [
    ...(label.trim() !== info.label ? [[info.name, label.trim()] as [string, string]] : []),
    ...endpoints.flatMap((endpoint): [string, string][] => {
      const next = labels[endpoint.name]?.trim();
      return next !== undefined && next !== endpoint.label ? [[`${info.name}/${endpoint.name}`, next]] : [];
    }),
  ];
  const empty = !label.trim() || endpoints.some((endpoint) => labels[endpoint.name]?.trim() === '');

  const save = async () => {
    if (empty || changed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const [target, text] of changed) await execCommand(`device-label ${shq(target)} ${shq(text)}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Edit device' subtitle={info.label} icon='pencil' pattern='device' onSubmit={save}>
      <Stack gap='sm'>
        <TextInput
          data-autofocus
          label='Name'
          description={`As its pages and cards show it; it stays ${info.name} in commands and rules.`}
          required
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        {endpoints.length > 0 && (
          <>
            <Text fw={500} size='sm' mt='xs'>Endpoints</Text>
            {endpoints.map((endpoint) => (
              <TextInput
                key={endpoint.name}
                label={endpoint.name}
                required
                value={labels[endpoint.name] ?? endpoint.label}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setLabels((current) => ({ ...current, [endpoint.name]: value }));
                }}
              />
            ))}
          </>
        )}
      </Stack>
      {error && <Alert mt='md' color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={empty || changed.length === 0}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
