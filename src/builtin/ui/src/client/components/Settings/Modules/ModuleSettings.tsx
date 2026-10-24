import { Alert, Badge, Group, Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import type { ConfigEntry } from '@ein/api';
import type { UseConfigResult } from '../../../hooks/useConfig.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { Note } from '../Accounts/PanelParts.tsx';
import { SettingActions, SettingInput, SettingSource, useSettingDraft } from '../SettingsForm.tsx';
import { ExpandRow } from './ExpandRow.tsx';

type ModuleSettingsProps = {
  /** The module's own settings. */
  entries: ConfigEntry[];
  save: UseConfigResult['save'];
  reset: UseConfigResult['reset'];
  /** Whether the reader may change a system setting; anyone may change their own. */
  admin: boolean;
};

/** A setting's value in force, as a cell says it: On, Not set, the empty value's meaning. */
const shownValue = (entry: ConfigEntry): string => {
  if (entry.type === 'secret') return entry.source === 'default' ? 'Not set' : 'Set';
  if (entry.type === 'boolean') return entry.value !== 'false' ? 'On' : 'Off';
  if (entry.value === '') return entry.emptyMeans ?? '—';
  return entry.value;
};

/**
 * A module's settings: what each is set to and whether it is the reader's own or the system's.
 * Each row opens to the setting's description, where its value comes from, and the control that
 * changes it — saved and restored as on the System tab, and only shown to whoever may change it.
 * On a phone the row leaves its scope to what it opens.
 */
export function ModuleSettings({ entries, save, reset, admin }: ModuleSettingsProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const phone = usePhone();

  if (entries.length === 0) return <Text size='sm' c='dimmed'>It adds no settings.</Text>;

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Table verticalSpacing='xs' highlightOnHover className='mrx-module-table'>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={36} pr={0} />
          <Table.Th>Setting</Table.Th>
          <Table.Th>Value</Table.Th>
          {!phone && <Table.Th>Scope</Table.Th>}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {entries.map((entry) => (
          <ExpandRow
            key={entry.key}
            open={open.has(entry.key)}
            onToggle={() => toggle(entry.key)}
            label={`Change ${entry.label}`}
            columns={phone ? 3 : 4}
            cells={
              <>
                <Table.Td>
                  <Text size='sm' fw={500}>{entry.label}</Text>
                </Table.Td>
                <Table.Td style={{ width: '40%', maxWidth: 0 }}>
                  <Text
                    size='sm'
                    ff={entry.value === '' || entry.type === 'boolean' || entry.type === 'secret' ? undefined : 'monospace'}
                    truncate
                    title={shownValue(entry)}
                  >
                    {shownValue(entry)}
                  </Text>
                </Table.Td>
                {!phone && (
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <ScopeBadge entry={entry} />
                  </Table.Td>
                )}
              </>
            }
          >
            <SettingEditor entry={entry} save={save} reset={reset} writable={entry.scope === 'user' || admin} />
          </ExpandRow>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Whose setting it is: the reader's own, or the whole system's. */
function ScopeBadge({ entry }: { entry: ConfigEntry }) {
  return (
    <Badge size='xs' radius='sm' variant='light' color={entry.scope === 'user' ? 'grape' : 'gray'} tt='none'>
      {entry.scope === 'user' ? 'personal' : 'system'}
    </Badge>
  );
}

/** One setting opened: what it is for, where its value comes from, and its control when the reader may change it. */
function SettingEditor({ entry, save, reset, writable }: { entry: ConfigEntry; save: UseConfigResult['save']; reset: UseConfigResult['reset']; writable: boolean }) {
  const draft = useSettingDraft(entry, save, reset);
  const description = entry.type !== 'secret' && entry.emptyMeans && draft.value === '' ? `${entry.description} Currently: ${entry.emptyMeans}.` : entry.description;

  return (
    <Stack gap='xs' maw={560}>
      <Text size='sm' c='dimmed'>{description}</Text>
      <Group gap='xs'>
        <ScopeBadge entry={entry} />
        <SettingSource entry={entry} />
        <Text size='xs' c='dimmed' ff='monospace'>{entry.key}</Text>
        {entry.restarts && entry.restarts.length > 0 && <Text size='xs' c='dimmed'>Restarts {entry.restarts.join(', ')}</Text>}
      </Group>
      {writable
        ? (
          <>
            <VisuallyHidden>
              <label id={draft.labelId} htmlFor={draft.controlId}>{entry.label}</label>
            </VisuallyHidden>
            <SettingInput entry={entry} draft={draft} />
            <SettingActions draft={draft} />
            {draft.note && <Text size='xs' c='dimmed'>{draft.note}</Text>}
            {draft.error && <Alert color='red' icon={<IconAlertTriangle size={16} />} p='xs'>{draft.error}</Alert>}
          </>
        )
        : <Note>Only an administrator can change a system setting.</Note>}
    </Stack>
  );
}
