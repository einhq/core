import { Alert, Badge, Box, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconClock, IconDoorEnter, IconShare, IconUserPlus } from '@tabler/icons-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import type { ConfigEntry } from '@ein/api';
import type { UseConfigResult } from '../../../hooks/useConfig.ts';
import { useIdentities } from '../../../hooks/useIdentities.ts';
import { displayName, humanDuration, parseGroupList } from '../../../lib/accounts.ts';
import { levelAt } from '../../../lib/share.ts';
import { PageLoader } from '../../Layout/PageLoader.tsx';
import { emptyLabel, GroupSelect, GroupsMultiSelect, parseModeSetting, PermissionsInput, UserSelect } from '../AccountInputs.tsx';
import { SettingActions, type SettingDraft, useSettingDraft } from '../SettingsForm.tsx';

const CAN = { edit: 'can change it', view: 'can see it', none: "can't see it" } as const;

/**
 * What the sharing defaults as saved make of something new: who owns it, which group it is shared
 * with, and what each may do. `owner` and `group` are the names to show; empty means the creator
 * and the creator's primary group. A mode that is not octal leaves the levels out.
 */
function sharingSentence(owner: string, group: string, mode: string): string {
  const lead = `${owner ? `Owned by ${owner} and shared` : 'Shared'} with ${group || "the creator's primary group"}`;
  const bits = parseModeSetting(mode);
  if (bits === undefined) return `${lead}.`;
  return `${lead}: the owner ${CAN[levelAt(bits, 6)]}, members ${CAN[levelAt(bits, 3)]}, anyone else ${CAN[levelAt(bits, 0)]}.`;
}

/** A saved number of seconds in words, or the number itself when it is not a duration. */
const durationWords = (value: string): string => humanDuration(Number(value)) || `${value} seconds`;

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

type DefaultsProps = { config: UseConfigResult };

/**
 * What a new account and anything created as shared start with, whether visitors may browse, and
 * how long a sign-in lasts: the system settings that govern accounts, as four cards that each say
 * in a sentence what the saved values come to, with a row per setting saved on its own. A setting
 * the registry does not have is left out, and so is a card left with none.
 */
export function AccountDefaults({ config }: DefaultsProps) {
  const { entries, loading, error, save, reset } = config;
  const { users, groups } = useIdentities();
  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);

  if (loading) return <PageLoader label='Loading settings…' />;

  const userTitle = (name: string) => {
    const user = users.find((candidate) => candidate.username === name);
    return user ? displayName(user) : name;
  };
  const groupTitle = (name: string) => {
    const group = groups.find((candidate) => candidate.groupname === name);
    return group ? displayName(group) : name;
  };

  const row = (key: string, label: string, help: string, control: (draft: SettingDraft, entry: ConfigEntry) => ReactNode, wide = false) => {
    const entry = byKey.get(key);
    return entry && <DefaultRow key={key} entry={entry} save={save} reset={reset} label={label} help={help} control={control} wide={wide} />;
  };
  const present = (...nodes: ReactNode[]) => nodes.filter(Boolean);
  const saved = (key: string) => byKey.get(key)?.value;

  const newUsers = present(
    row('CFG_DEFAULT_USER_GROUPS', 'Groups', "Ticked on the New user form, besides the account's own group.", (draft, entry) => (
      <GroupsMultiSelect
        id={draft.controlId}
        value={draft.value}
        onChange={draft.setValue}
        disabled={draft.busy}
        placeholder={draft.value ? undefined : emptyLabel(entry)}
      />
    )),
  );
  const visitors = present(
    row('CFG_GUEST_BROWSING', 'Visitors may browse', 'Anyone who opens EiN sees what is shared with visitors, without signing in.', (draft) => (
      <Switch
        id={draft.controlId}
        label={draft.value === 'true' ? 'On' : 'Off'}
        checked={draft.value === 'true'}
        disabled={draft.busy}
        onChange={(event) => draft.setValue(event.currentTarget.checked ? 'true' : 'false')}
      />
    )),
  );
  const sharingGroup = saved('CFG_DEFAULT_SHARE_GROUP');
  const sharing = present(
    row(
      'CFG_DEFAULT_SHARE_OWNER',
      'Owner',
      'Who owns it. Empty: whoever creates it.',
      (draft, entry) => <UserSelect id={draft.controlId} value={draft.value} onChange={draft.setValue} disabled={draft.busy} emptyLabel={emptyLabel(entry)} />,
    ),
    row(
      'CFG_DEFAULT_SHARE_GROUP',
      'Group',
      "The group it is shared with, whose members get the group's access.",
      (draft, entry) => <GroupSelect id={draft.controlId} value={draft.value} onChange={draft.setValue} disabled={draft.busy} emptyLabel={emptyLabel(entry)} />,
    ),
    row('CFG_DEFAULT_SHARE_MODE', 'Permissions', 'What the owner, the group and anyone else may do with it.', (draft) => (
      <PermissionsInput
        id={draft.controlId}
        labelledBy={draft.labelId}
        group={sharingGroup}
        value={draft.value}
        onChange={draft.setValue}
        disabled={draft.busy}
      />
    ), true),
  );
  const sessions = present(
    row(
      'CFG_SESSION_MAX_AGE_SEC',
      'Browser sign-in',
      'How long a browser stays signed in after its last visit.',
      (draft, entry) => <DurationInput key={entry.value} id={draft.controlId} value={draft.value} onChange={draft.setValue} disabled={draft.busy} />,
    ),
    row(
      'CFG_SESSION_EXPIRES_SEC',
      'Idle session',
      'How long a session lasts unused. A change applies to new sign-ins.',
      (draft, entry) => <DurationInput key={entry.value} id={draft.controlId} value={draft.value} onChange={draft.setValue} disabled={draft.busy} />,
    ),
  );

  const defaultGroups = parseGroupList(saved('CFG_DEFAULT_USER_GROUPS') ?? '');
  const owner = saved('CFG_DEFAULT_SHARE_OWNER');
  const cookie = saved('CFG_SESSION_MAX_AGE_SEC');
  const idle = saved('CFG_SESSION_EXPIRES_SEC');
  const sessionClauses = [
    cookie !== undefined && `a browser stays signed in for ${durationWords(cookie)} after its last visit`,
    idle !== undefined && `a session unused for ${durationWords(idle)} ends`,
  ].filter((clause): clause is string => Boolean(clause));
  const sessionSentence = sessionClauses.join(', and ');

  return (
    <Stack gap='lg'>
      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
          {error.message}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing='lg' verticalSpacing='lg'>
        {newUsers.length > 0 && (
          <DefaultsCard
            hue='marine'
            icon={<IconUserPlus size={22} />}
            title='New users'
            state={defaultGroups.length > 0 ? `New accounts join ${listFormat.format(defaultGroups.map(groupTitle))}.` : 'New accounts join no group besides their own.'}
          >
            {newUsers}
          </DefaultsCard>
        )}

        {visitors.length > 0 && (
          <DefaultsCard
            hue='yellow'
            icon={<IconDoorEnter size={22} />}
            title='Visitors'
            state={saved('CFG_GUEST_BROWSING') === 'true' ? 'Visitors browse what is shared with them, without signing in.' : 'Visitors are asked to sign in.'}
          >
            {visitors}
          </DefaultsCard>
        )}

        {sharing.length > 0 && (
          <DefaultsCard
            hue='teal'
            icon={<IconShare size={22} />}
            title='Sharing'
            state={sharingSentence(owner ? userTitle(owner) : '', sharingGroup ? groupTitle(sharingGroup) : '', saved('CFG_DEFAULT_SHARE_MODE') ?? '')}
            caption='What anything created as shared starts with.'
          >
            {sharing}
          </DefaultsCard>
        )}

        {sessions.length > 0 && (
          <DefaultsCard
            hue='violet'
            icon={<IconClock size={22} />}
            title='Sign-in sessions'
            state={`${sessionSentence[0].toUpperCase()}${sessionSentence.slice(1)}.`}
          >
            {sessions}
          </DefaultsCard>
        )}
      </SimpleGrid>
    </Stack>
  );
}

type DefaultsCardProps = {
  /** A theme colour, for the icon's tile. */
  hue: string;
  icon: ReactNode;
  title: string;
  /** What the saved values come to, in a sentence. */
  state: string;
  /** What the settings are for, where the title does not say it. */
  caption?: string;
  children: ReactNode;
};

function DefaultsCard({ hue, icon, title, state, caption, children }: DefaultsCardProps) {
  const titleId = useId();
  return (
    <Paper component='section' aria-labelledby={titleId} withBorder p={{ base: 'md', sm: 'lg' }} radius='md'>
      <Group gap='md' wrap='nowrap' align='flex-start' pb='md'>
        <Box
          w={40}
          h={40}
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--mantine-radius-md)',
            background: `color-mix(in srgb, var(--mantine-color-${hue}-filled) 18%, var(--mrx-surface-raised))`,
            color: `var(--mantine-color-${hue}-light-color)`,
          }}
        >
          {icon}
        </Box>
        <Box style={{ minWidth: 0 }}>
          <Title order={4} id={titleId}>{title}</Title>
          <Text size='sm' mt={4}>{state}</Text>
          {caption && <Text size='xs' c='dimmed' mt={4}>{caption}</Text>}
        </Box>
      </Group>
      {children}
    </Paper>
  );
}

type DefaultRowProps = {
  entry: ConfigEntry;
  save: UseConfigResult['save'];
  reset: UseConfigResult['reset'];
  label: string;
  /** One line under the label on what the setting does. */
  help: string;
  control: (draft: SettingDraft, entry: ConfigEntry) => ReactNode;
  /** Keeps the control at least as wide as several pickers side by side, moving it under the label sooner. */
  wide: boolean;
};

/**
 * One setting as a row under a hairline: its label and help beside the control, or above it where
 * the card is narrow, with Save, Cancel or Restore under the control and a badge while it is set
 * here. What a save did, or why it failed, is said under the row.
 */
function DefaultRow({ entry, save, reset, label, help, control, wide }: DefaultRowProps) {
  const draft = useSettingDraft(entry, save, reset);
  return (
    <Box py='sm' style={{ borderTop: '1px solid var(--mrx-hairline)' }}>
      <Group gap='sm' align='flex-start' wrap='wrap'>
        <Box style={{ flex: '1 1 12rem', minWidth: 0 }}>
          <Group gap={6} wrap='nowrap'>
            <Text component='label' id={draft.labelId} htmlFor={draft.controlId} size='sm' fw={600}>{label}</Text>
            {draft.overridden && <Badge size='xs' variant='light' color='marine' tt='none'>Set here</Badge>}
          </Group>
          <Text size='xs' c='dimmed'>{help}</Text>
        </Box>
        <Stack gap='xs' style={{ flex: '1 1 15rem', minWidth: wide ? '19rem' : 0 }}>
          {control(draft, entry)}
          <SettingActions draft={draft} />
        </Stack>
      </Group>
      {draft.note && <Text size='xs' c='dimmed' mt='xs'>{draft.note}</Text>}
      {draft.error && <Alert color='red' icon={<IconAlertTriangle size={16} />} p='xs' mt='xs'>{draft.error}</Alert>}
    </Box>
  );
}

const UNITS = [
  { seconds: 86400, one: 'day', many: 'days' },
  { seconds: 3600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
];

/** The largest unit a number of seconds is a whole count of. */
const unitFor = (seconds: number): number => UNITS.find((unit) => seconds > 0 && seconds % unit.seconds === 0)?.seconds ?? 1;

type DurationInputProps = { id: string; value: string; onChange: (next: string) => void; disabled: boolean };

/**
 * A number of seconds, the value a setting holds, as a count of days, hours, minutes or seconds. It
 * starts in the largest unit the value is a whole count of; choosing another unit keeps the count,
 * so typing 2 and choosing days makes two days. A value the chosen unit does not divide is shown in
 * the unit that does.
 */
function DurationInput({ id, value, onChange, disabled }: DurationInputProps) {
  const seconds = value === '' ? Number.NaN : Number(value);
  const [chosen, setChosen] = useState(() => unitFor(seconds));
  const valid = Number.isFinite(seconds);
  const unit = valid && seconds % chosen !== 0 ? unitFor(seconds) : chosen;
  const count = valid ? seconds / unit : '';

  return (
    <Group gap='xs' wrap='nowrap'>
      <NumberInput
        id={id}
        value={count}
        disabled={disabled}
        min={1}
        allowNegative={false}
        allowDecimal={false}
        style={{ flex: 1, minWidth: 0 }}
        onChange={(next) => onChange(next === '' ? '' : String(Number(next) * unit))}
      />
      <Select
        aria-label='Unit'
        w={112}
        data={UNITS.map((option) => ({ value: String(option.seconds), label: count === 1 ? option.one : option.many }))}
        value={String(unit)}
        disabled={disabled}
        allowDeselect={false}
        onChange={(next) => {
          if (!next) return;
          setChosen(Number(next));
          if (typeof count === 'number') onChange(String(count * Number(next)));
        }}
      />
    </Group>
  );
}
