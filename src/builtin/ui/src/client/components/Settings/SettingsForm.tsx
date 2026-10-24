import { Alert, Badge, Box, Button, Grid, Group, NavLink, NumberInput, Paper, PasswordInput, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconAlertTriangle, IconDeviceFloppy, IconRotateClockwise, IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ConfigEntry } from '@ein/ui/signals';
import type { SaveResult } from '@ein/ui/hooks';
import { matchesText } from '@ein/ui/lib';
import { emptyLabel, GroupSelect, PermissionsInput, sameMode, UserSelect } from './AccountInputs.tsx';

type SettingsFormProps = {
  entries: ConfigEntry[];
  save: (key: string, value: string) => Promise<SaveResult>;
  reset: (key: string) => Promise<SaveResult>;
  /** Shown when there is nothing to render, e.g. a module that owns no settings is absent. */
  emptyMessage?: string;
};

type SettingsGroup = {
  name: string;
  entries: ConfigEntry[];
  overrides: number;
};

const isOverride = (entry: ConfigEntry): boolean => entry.source === entry.scope;

const matchesQuery = (entry: ConfigEntry, query: string): boolean =>
  matchesText([entry.label, entry.description, entry.group, entry.owner, entry.key, ...(entry.choices ?? [])], query);

/**
 * A searchable category browser for the generic configuration registry.
 *
 * The registry remains the only source of structure: modules can add an option
 * or an entirely new category without changing this component. Showing one
 * category at a time gives a long registry an index and a stable work area,
 * while search deliberately crosses category boundaries.
 */
export function SettingsForm({ entries, save, reset, emptyMessage }: SettingsFormProps) {
  const groups = useMemo<SettingsGroup[]>(() => {
    const grouped = new Map<string, ConfigEntry[]>();
    for (const entry of entries) grouped.set(entry.group, [...(grouped.get(entry.group) ?? []), entry]);
    return [...grouped].map(([name, groupedEntries]) => ({
      name,
      entries: groupedEntries,
      overrides: groupedEntries.filter(isOverride).length,
    }));
  }, [entries]);
  const [activeGroup, setActiveGroup] = useState(groups[0]?.name ?? '');
  const [query, setQuery] = useState('');
  const [overridesOnly, setOverridesOnly] = useState(false);

  useEffect(() => {
    if (!groups.some((group) => group.name === activeGroup)) setActiveGroup(groups[0]?.name ?? '');
  }, [activeGroup, groups]);

  if (entries.length === 0) {
    return <Text c='dimmed'>{emptyMessage ?? 'No settings available.'}</Text>;
  }

  const normalizedQuery = query.trim();
  const candidates = normalizedQuery ? entries : groups.find((group) => group.name === activeGroup)?.entries ?? [];
  const visibleEntries = candidates.filter((entry) => (!overridesOnly || isOverride(entry)) && (!normalizedQuery || matchesQuery(entry, normalizedQuery)));
  const visibleGroups = groups
    .map((group) => ({ ...group, entries: visibleEntries.filter((entry) => entry.group === group.name) }))
    .filter((group) => group.entries.length > 0);
  const overrideCount = entries.filter(isOverride).length;
  const resultLabel = normalizedQuery
    ? `${visibleEntries.length} search ${visibleEntries.length === 1 ? 'result' : 'results'}`
    : `${visibleEntries.length} ${visibleEntries.length === 1 ? 'setting' : 'settings'}`;

  const chooseGroup = (group: string) => {
    setActiveGroup(group);
    setQuery('');
  };

  const clearFilters = () => {
    setQuery('');
    setOverridesOnly(false);
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <Group justify='space-between' align='flex-end'>
            <TextInput
              style={{ flex: 1, minWidth: 240 }}
              label='Find a setting'
              placeholder='Search names, descriptions, modules or keys'
              leftSection={<IconSearch size={16} />}
              rightSection={query
                ? (
                  <Button variant='transparent' size='compact-xs' px={4} aria-label='Clear search' onClick={() => setQuery('')}>
                    <IconX size={15} />
                  </Button>
                )
                : undefined}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Button
              variant={overridesOnly ? 'light' : 'default'}
              color={overridesOnly ? 'marine' : undefined}
              leftSection={<IconAdjustmentsHorizontal size={16} />}
              onClick={() => setOverridesOnly((current) => !current)}
            >
              Overrides only{overrideCount > 0 ? ` (${overrideCount})` : ''}
            </Button>
          </Group>
          <Text size='xs' c='dimmed'>
            Browse by category or search across all {entries.length} settings. Overrides are values saved in EiN rather than defaults or deployment values.
          </Text>
        </Stack>
      </Paper>

      <Select
        hiddenFrom='sm'
        label='Category'
        data={groups.map((group) => ({ value: group.name, label: `${group.name} (${group.entries.length})` }))}
        value={activeGroup}
        allowDeselect={false}
        disabled={Boolean(normalizedQuery)}
        onChange={(group) => group && chooseGroup(group)}
      />

      <Grid gap='xl' align='flex-start'>
        <Grid.Col span={{ base: 12, sm: 4, md: 3 }} visibleFrom='sm'>
          <Paper
            p='xs'
            radius='md'
            withBorder
            style={{
              position: 'sticky',
              // Below the app header and the page header's row stuck under it.
              top: 'calc(var(--app-shell-header-height, 0px) + var(--mrx-stuck-header-height, 0px) + var(--mantine-spacing-lg))',
            }}
          >
            <Text size='xs' fw={700} c='dimmed' tt='uppercase' px='sm' py='xs'>Categories</Text>
            {groups.map((group) => (
              <NavLink
                key={group.name}
                label={group.name}
                leftSection={<IconSettings size={16} />}
                rightSection={
                  <Badge size='sm' variant={group.overrides > 0 ? 'light' : 'default'} color={group.overrides > 0 ? 'marine' : 'gray'}>
                    {group.entries.length}
                  </Badge>
                }
                active={!normalizedQuery && group.name === activeGroup}
                color='marine'
                variant='light'
                onClick={() => chooseGroup(group.name)}
              />
            ))}
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
          <Stack gap='lg'>
            <Box>
              <Title order={3}>{normalizedQuery ? 'Search results' : activeGroup}</Title>
              <Text size='sm' c='dimmed'>{resultLabel}{overridesOnly ? ' set here' : ''}</Text>
            </Box>

            {visibleGroups.length > 0
              ? visibleGroups.map((group) => (
                <Stack key={group.name} gap='sm'>
                  {normalizedQuery && <Title order={5}>{group.name}</Title>}
                  {group.entries.map((entry) => <SettingField key={entry.key} entry={entry} save={save} reset={reset} />)}
                </Stack>
              ))
              : (
                <Paper p='xl' radius='md' withBorder>
                  <Stack align='center' gap='xs'>
                    <IconSearch size={28} color='var(--mantine-color-dimmed)' />
                    <Text fw={600}>No settings match</Text>
                    <Text size='sm' c='dimmed' ta='center'>Try another search or include defaults and deployment values.</Text>
                    <Button variant='subtle' size='xs' onClick={clearFilters}>Clear filters</Button>
                  </Stack>
                </Paper>
              )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

type SettingFieldProps = {
  entry: ConfigEntry;
  save: SettingsFormProps['save'];
  reset: SettingsFormProps['reset'];
  /** Draws the control for the value, in place of the one its type gets. */
  input?: (props: { id: string; value: string; setValue: (next: string) => void; busy: boolean }) => ReactNode;
};

/** One setting being edited, as `useSettingDraft` keeps it. */
export type SettingDraft = {
  /** The value in the control, saved or not. */
  value: string;
  setValue: (next: string) => void;
  /** Whether the value differs from the one in force; a mode compares as a mode, so `755` is `0755`. */
  dirty: boolean;
  /** Whether the value in force is saved here, which Restore clears. */
  overridden: boolean;
  /** While a save or a restore runs. */
  busy: boolean;
  /** What the last save or restore restarted, or what a restart is still needed for. */
  note: string | null;
  /** Why the last save or restore, or a restart after it, failed. */
  error: string | null;
  /** The control's id, for its label's `htmlFor`. */
  controlId: string;
  /** The label's id, for a control made of several that the label names as a whole. */
  labelId: string;
  /** Save the value. */
  commit: () => void;
  /** Put the value in force back in the control. */
  cancel: () => void;
  /** Clear the value saved here, so the inherited one is in force. */
  restore: () => void;
};

/**
 * The state of one setting's control: the value being edited, whether it differs from the one in
 * force, and Save, Cancel and Restore, with what the last of them did or why it failed. A save
 * refetches the whole table, and another setting's save must not discard what is being typed here,
 * so only a change to this entry's own value replaces it.
 */
export function useSettingDraft(entry: ConfigEntry, save: SettingsFormProps['save'], reset: SettingsFormProps['reset']): SettingDraft {
  const [value, setValue] = useState(entry.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setValue(entry.value);
  }, [entry.value]);

  const run = async (action: () => Promise<SaveResult>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await action();
      // A key never comes back, so nothing else would empty the field once it is saved.
      if (entry.type === 'secret') setValue('');
      setNote(
        result.restarted.length > 0 ? `Restarted ${result.restarted.join(', ')}.` : result.restartNote ?? null,
      );
      for (const failure of result.failed) setError(`Could not restart ${failure.name}: ${failure.error}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const controlId = `setting-${entry.key}`;
  return {
    value,
    setValue,
    dirty: entry.type === 'mode' ? !sameMode(value, entry.value) : value !== entry.value,
    overridden: isOverride(entry),
    busy,
    note,
    error,
    controlId,
    labelId: `${controlId}-label`,
    commit: () => run(() => save(entry.key, value)),
    cancel: () => setValue(entry.value),
    restore: () => run(() => reset(entry.key)),
  };
}

/** Save and Cancel while the value is changed, Restore while it is set here, and nothing otherwise. */
export function SettingActions({ draft }: { draft: SettingDraft }) {
  if (!draft.dirty && !draft.overridden) return null;
  return (
    <Group justify='flex-end' gap='xs'>
      {draft.dirty
        ? (
          <>
            <Button variant='subtle' size='xs' disabled={draft.busy} onClick={draft.cancel}>Cancel</Button>
            <Button size='xs' loading={draft.busy} leftSection={<IconDeviceFloppy size={14} />} onClick={draft.commit}>
              Save change
            </Button>
          </>
        )
        : (
          <Button size='xs' variant='subtle' disabled={draft.busy} leftSection={<IconRotateClockwise size={14} />} onClick={draft.restore}>
            Restore inherited value
          </Button>
        )}
    </Group>
  );
}

/**
 * One setting: its label, description and where its value comes from, a control for the value, and
 * Save and Cancel while it is changed or Restore while it is set here. What a save did, or why it
 * failed, is said under the field.
 */
export function SettingField({ entry, save, reset, input }: SettingFieldProps) {
  const draft = useSettingDraft(entry, save, reset);
  const { value, setValue, busy, controlId, labelId, note, error } = draft;

  const description = entry.type !== 'secret' && entry.emptyMeans && value === '' ? `${entry.description} Currently: ${entry.emptyMeans}.` : entry.description;

  return (
    <Paper p='md' radius='md' withBorder>
      <Grid gap='md' align='center'>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap={5}>
            <Text component='label' id={labelId} htmlFor={controlId} fw={600}>{entry.label}</Text>
            <Text size='sm' c='dimmed'>{description}</Text>
            <Group gap='xs'>
              <SettingSource entry={entry} />
              {entry.owner && <Badge size='xs' variant='outline'>{entry.owner}</Badge>}
              {entry.restarts && entry.restarts.length > 0 && <Text size='xs' c='dimmed'>Restarts {entry.restarts.join(', ')}</Text>}
            </Group>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap='xs'>
            {input ? input({ id: controlId, value, setValue, busy }) : <SettingInput entry={entry} draft={draft} />}
            <SettingActions draft={draft} />
          </Stack>
        </Grid.Col>

        {(note || error) && (
          <Grid.Col span={12}>
            {note && <Text size='xs' c='dimmed'>{note}</Text>}
            {error && <Alert color='red' icon={<IconAlertTriangle size={16} />} p='xs'>{error}</Alert>}
          </Grid.Col>
        )}
      </Grid>
    </Paper>
  );
}

/** Where the value in force came from. */
const sourceLabel = (entry: ConfigEntry): string => {
  switch (entry.source) {
    case 'default':
      return entry.type === 'secret' ? 'Not set' : 'Default';
    case 'module':
      return entry.sourceModule ? `From ${entry.sourceModule}` : 'From a module';
    case 'environment':
      return 'From deployment';
    case 'system':
      return 'Set here';
    case 'user':
      return 'Your setting';
  }
};

const sourceColor = (source: ConfigEntry['source']): string => (source === 'default' ? 'gray' : source === 'environment' || source === 'module' ? 'yellow' : 'marine');

/** Where a setting's value in force came from, as a badge: Default, Set here, From deployment. */
export function SettingSource({ entry }: { entry: ConfigEntry }) {
  return <Badge size='xs' variant='light' color={sourceColor(entry.source)}>{sourceLabel(entry)}</Badge>;
}

/** The control a setting's type gets, editing the draft's value: a switch, a select, an account picker. */
export function SettingInput({ entry, draft }: { entry: ConfigEntry; draft: SettingDraft }) {
  const { controlId: id, labelId, value, setValue, busy } = draft;
  switch (entry.type) {
    case 'secret':
      // Its value never comes back from the server, so the field holds only a new one being typed;
      // `new-password` keeps the browser from filling in the sign-in password it saved.
      return (
        <PasswordInput
          id={id}
          value={value}
          disabled={busy}
          autoComplete='new-password'
          placeholder={entry.source === 'default' ? 'Not set' : 'Set — type a new one to replace it'}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      );
    case 'boolean':
      return (
        <Switch
          id={id}
          label={value !== 'false' ? 'On' : 'Off'}
          checked={value !== 'false'}
          disabled={busy}
          onChange={(event) => setValue(event.currentTarget.checked ? 'true' : 'false')}
        />
      );
    case 'select':
      return (
        <Select
          id={id}
          data={entry.choices ?? []}
          value={value}
          disabled={busy}
          allowDeselect={false}
          onChange={(next) => setValue(next ?? entry.default)}
        />
      );
    case 'number':
      return (
        <NumberInput
          id={id}
          value={value === '' ? '' : Number(value)}
          disabled={busy}
          onChange={(next) => setValue(String(next))}
        />
      );
    case 'user':
      return <UserSelect id={id} value={value} disabled={busy} emptyLabel={emptyLabel(entry)} onChange={setValue} />;
    case 'group':
      return <GroupSelect id={id} value={value} disabled={busy} emptyLabel={emptyLabel(entry)} onChange={setValue} />;
    case 'mode':
      return <PermissionsInput id={id} labelledBy={labelId} value={value} disabled={busy} onChange={setValue} />;
    default:
      return (
        <TextInput
          id={id}
          value={value}
          disabled={busy}
          placeholder={entry.emptyMeans ? `Empty means ${entry.emptyMeans}` : undefined}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      );
  }
}
