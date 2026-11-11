import { Alert, Box, Button, Group, PasswordInput, Stack, Table, Text, TextInput } from '@mantine/core';
import { type ChangeEvent, useEffect, useState } from 'react';
import type { DeviceConfigAnswer } from '@ein/api';
import { useCommand } from '../../hooks/useCommand.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { Dialog, DialogActions } from '../Surface/Dialog.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/**
 * What a device's driver was given (`device-config`): each field its driver asks for, a secret one
 * as set or not, never its value. A member of the devices group changes it with Change while the
 * driver runs; a secret field left empty keeps what it had.
 */
export function DeviceConfig({ device, member, onSaved }: { device: string; member: boolean; onSaved: () => void }) {
  const { data, error, refetch } = useCommand<DeviceConfigAnswer>(`device-config ${shq(device)}`);
  const [editing, setEditing] = useState(false);
  if (error) return <Text size='sm' c='dimmed'>{error.message}</Text>;
  if (!data) return null;
  const named = new Set(data.fields.map((field) => field.name));
  const rows: [string, string, string][] = [
    ...data.fields.map((field): [string, string, string] => [
      field.name,
      field.label,
      field.secret ? (data.secrets.includes(field.name) ? 'set' : '') : data.config[field.name] ?? '',
    ]),
    ...Object.entries(data.config).filter(([name]) => !named.has(name)).map(([name, value]): [string, string, string] => [name, name, value]),
  ];
  if (rows.length === 0) return <Text size='sm' c='dimmed'>Its driver takes no config.</Text>;
  return (
    <Stack gap='xs'>
      <Table>
        <Table.Tbody>
          {rows.map(([name, label, value]) => (
            <Table.Tr key={name}>
              <Table.Td c='dimmed' w={260}>{label}</Table.Td>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>{value || <Text span size='sm' c='dimmed'>not set</Text>}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {member && (
        <Group>
          <Button
            variant='default'
            size='xs'
            leftSection={<TablerIcon name='pencil' size={14} />}
            disabled={!data.running || data.fields.length === 0}
            title={data.running ? undefined : `${data.driver} is not running`}
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
        </Group>
      )}
      {member && (
        <ConfigModal
          opened={editing}
          onClose={() => setEditing(false)}
          answer={data}
          onSaved={() => {
            void refetch();
            onSaved();
          }}
        />
      )}
    </Stack>
  );
}

function ConfigModal({ opened, onClose, answer, onSaved }: { opened: boolean; onClose: () => void; answer: DeviceConfigAnswer; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setValues(Object.fromEntries(answer.fields.map((field) => [field.name, field.secret ? '' : answer.config[field.name] ?? ''])));
    setError(null);
  }, [opened]);

  const changed = answer.fields.flatMap((field) => {
    const value = (values[field.name] ?? '').trim();
    if (field.secret) return value ? [`${field.name}=${value}`] : [];
    return value !== (answer.config[field.name] ?? '') ? [`${field.name}=${value}`] : [];
  });

  const save = async () => {
    if (changed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await execCommand(`device-config ${shq(answer.device)} ${changed.map(shq).join(' ')}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Change config' subtitle={answer.device} icon='settings' pattern='device' onSubmit={save}>
      <Stack gap='sm'>
        {answer.fields.map((field, index) => {
          const props = {
            label: field.label,
            description: field.name,
            required: field.required,
            value: values[field.name] ?? '',
            'data-autofocus': index === 0 || undefined,
            onChange: (event: ChangeEvent<HTMLInputElement>) => {
              const value = event.currentTarget.value;
              setValues((current) => ({ ...current, [field.name]: value }));
            },
          };
          return field.secret
            ? (
              <PasswordInput
                key={field.name}
                {...props}
                autoComplete='new-password'
                placeholder={answer.secrets.includes(field.name) ? 'Set — type a new one to replace it' : 'Not set'}
              />
            )
            : <TextInput key={field.name} {...props} />;
        })}
      </Stack>
      {error && (
        <Box mt='md'>
          <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>
        </Box>
      )}
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={changed.length === 0}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
