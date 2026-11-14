import { Alert, Badge, Box, Group, Paper, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconDoorEnter, IconShare, IconUserPlus } from '@tabler/icons-react';
import { type ReactNode, useId, useMemo } from 'react';
import type { ConfigEntry } from '@ein/api';
import type { UseConfigResult } from '../../../hooks/useConfig.ts';
import { useIdentities } from '../../../hooks/useIdentities.ts';
import { displayName, parseGroupList } from '../../../lib/accounts.ts';
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

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

type DefaultsProps = { config: UseConfigResult };

/**
 * What a new account and anything created as shared start with, and whether visitors may browse:
 * the system settings that govern accounts, as three cards that each say
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
  const defaultGroups = parseGroupList(saved('CFG_DEFAULT_USER_GROUPS') ?? '');
  const owner = saved('CFG_DEFAULT_SHARE_OWNER');

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
