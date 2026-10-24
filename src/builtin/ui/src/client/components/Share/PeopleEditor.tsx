import { Button, Group, Menu, Select, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCheck, IconChevronDown, IconLock, IconUserPlus, IconWorld } from '@tabler/icons-react';
import { useMemo } from 'react';
import type { ShareInfo, ShareLevel } from '@ein/api';
import { grantKey, listedGrants, type ShareDraft, visitorsSee, withGrant, withGrantLevel, withoutGrant, withVisitors } from '../../lib/share.ts';
import { GrantIdentity, OwnerIdentity } from './ShareIdentity.tsx';

const LEVELS: { level: Exclude<ShareLevel, 'none'>; label: string; detail: string }[] = [
  { level: 'view', label: 'Can view', detail: 'See it and download it' },
  { level: 'edit', label: 'Can edit', detail: 'Also add to it, change it and delete from it' },
];

const levelLabel = (level: ShareLevel): string => LEVELS.find((each) => each.level === level)?.label ?? 'No access';

/** What one row allows, and the menu that changes it when the reader may. */
function LevelControl({ level, editable, label, onLevel, onRemove }: {
  level: Exclude<ShareLevel, 'none'>;
  editable: boolean;
  /** Who the row is, for a screen reader. */
  label: string;
  onLevel: (level: Exclude<ShareLevel, 'none'>) => void;
  onRemove: () => void;
}) {
  if (!editable) return <Text size='sm' c='dimmed' style={{ flex: 'none' }}>{levelLabel(level)}</Text>;

  return (
    <Menu position='bottom-end' shadow='md' width={260} withinPortal>
      <Menu.Target>
        <Button
          variant='subtle'
          color='gray'
          size='compact-sm'
          rightSection={<IconChevronDown size={14} />}
          aria-label={`${label}: ${levelLabel(level)}`}
          style={{ flex: 'none' }}
        >
          {levelLabel(level)}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {LEVELS.map((each) => (
          <Menu.Item key={each.level} onClick={() => onLevel(each.level)} rightSection={each.level === level ? <IconCheck size={16} /> : null}>
            <Text size='sm'>{each.label}</Text>
            <Text size='xs' c='dimmed'>{each.detail}</Text>
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item color='red' onClick={onRemove}>Remove access</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

type PeopleEditorProps = {
  draft: ShareDraft;
  onChange: (draft: ShareDraft) => void;
  info: Pick<ShareInfo, 'groups' | 'users' | 'guestBrowsing'>;
  /** The node's owner; absent for several nodes, each with its own. */
  owner?: { uid: number; name: string; username?: string; path?: string; personPath?: string; you: boolean };
  /** How many nodes it edits, for the words that stand in for their owners. */
  count?: number;
  editable: boolean;
  /** An administrator may see who is in a group. */
  showMembers: boolean;
};

/**
 * Who may see and change a node: its owner, then everyone given access, each with what they may
 * do, and someone new added from the box at the top. Visitors who are not signed in are one more
 * row, a grant to the guest's group, where they may browse or that grant is already there.
 */
export function PeopleEditor({ draft, onChange, info, owner, count = 1, editable, showMembers }: PeopleEditorProps) {
  const rows = listedGrants(draft);

  // Everyone not listed, the group of everyone with an account first, then groups, then people.
  // Deduplicated by value: two group nodes can carry one gid, which is one grant to the access
  // model, and Mantine throws on a repeated value.
  const options = useMemo(() => {
    const listed = new Set(rows.map((grant) => `${grant.kind}:${grant.id}`));
    const seen = new Set<string>();
    const groups = info.groups
      .filter((group) => group.role !== 'guests')
      .map((group) => ({
        value: `group:${group.gid}`,
        label: group.role === 'everyone' ? 'Everyone with an account' : `${group.title ?? group.groupname} (group)`,
        first: group.role === 'everyone',
      }))
      .sort((a, b) => Number(b.first) - Number(a.first) || a.label.localeCompare(b.label));
    const users = info.users
      .filter((user) => user.uid !== owner?.uid)
      .map((user) => ({ value: `user:${user.uid}`, label: user.title ? `${user.title} (${user.username})` : user.username, first: false }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const offered: { value: string; label: string }[] = [];
    for (const { value, label } of [...groups, ...users]) {
      if (listed.has(value) || seen.has(value)) continue;
      seen.add(value);
      offered.push({ value, label });
    }
    return offered;
  }, [info, rows, owner?.uid]);

  const add = (value: string | null) => {
    if (!value) return;
    const [kind, raw] = value.split(':');
    const id = Number(raw);
    if (kind === 'group') {
      const group = info.groups.find((candidate) => candidate.gid === id);
      if (group) onChange(withGrant(draft, { kind: 'group', id, name: group.groupname, title: group.title, members: group.members, role: group.role, level: 'view' }));
    } else {
      const user = info.users.find((candidate) => candidate.uid === id);
      if (user) {
        onChange(withGrant(draft, { kind: 'user', id, name: user.username, title: user.title, path: user.path, personPath: user.personPath, level: 'view' }));
      }
    }
  };

  const visitors = visitorsSee(draft);
  const guests = info.groups.find((group) => group.role === 'guests')?.groupname;

  return (
    <Stack gap='xs'>
      {editable && (
        <Select
          searchable
          value={null}
          onChange={add}
          data={options}
          placeholder='Add people or groups'
          nothingFoundMessage='Nobody by that name'
          leftSection={<IconUserPlus size={16} />}
          aria-label='Add people or groups'
        />
      )}

      <Stack gap='sm' mt={editable ? 4 : 0}>
        {owner
          ? (
            <Group gap='sm' wrap='nowrap'>
              <OwnerIdentity name={owner.name} username={owner.username} path={owner.personPath ?? owner.path} you={owner.you} />
              <Text size='sm' c='dimmed' style={{ flex: 'none' }}>Owner</Text>
            </Group>
          )
          : <Text size='sm' c='dimmed'>{count === 1 ? 'Its owner can always see and change it.' : 'Each keeps its owner, who can always see and change it.'}</Text>}

        {rows.map((grant) => (
          <Group key={grantKey(grant)} gap='sm' wrap='nowrap'>
            <GrantIdentity grant={grant} showMembers={showMembers} />
            <LevelControl
              level={grant.level as Exclude<ShareLevel, 'none'>}
              editable={editable}
              label={grant.title ?? grant.name}
              onLevel={(level) => onChange(withGrantLevel(draft, grantKey(grant), level))}
              onRemove={() => onChange(withoutGrant(draft, grantKey(grant)))}
            />
          </Group>
        ))}

        {(info.guestBrowsing || visitors) && (
          <Group gap='sm' wrap='nowrap'>
            <Group gap='sm' wrap='nowrap' style={{ flex: 1, minWidth: 0 }}>
              <ThemeIcon size={32} radius='xl' variant='light' color={visitors ? 'teal' : 'gray'} style={{ flex: 'none' }}>
                {visitors ? <IconWorld size={18} /> : <IconLock size={18} />}
              </ThemeIcon>
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size='sm'>Visitors who are not signed in</Text>
                <Text size='xs' c='dimmed'>
                  {info.guestBrowsing ? 'Anyone who opens EiN, without an account' : 'This EiN asks visitors to sign in, so they see it only once it lets them browse'}
                </Text>
              </Stack>
            </Group>
            {editable
              ? (
                <Menu position='bottom-end' shadow='md' withinPortal>
                  <Menu.Target>
                    <Button variant='subtle' color='gray' size='compact-sm' rightSection={<IconChevronDown size={14} />} style={{ flex: 'none' }}>
                      {visitors ? 'Can view' : 'No access'}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => onChange(withVisitors(draft, true, guests))} rightSection={visitors ? <IconCheck size={16} /> : null}>Can view</Menu.Item>
                    <Menu.Item onClick={() => onChange(withVisitors(draft, false))} rightSection={visitors ? null : <IconCheck size={16} />}>No access</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )
              : <Text size='sm' c='dimmed' style={{ flex: 'none' }}>{visitors ? 'Can view' : 'No access'}</Text>}
          </Group>
        )}

        {rows.length === 0 && !visitors && <Text size='xs' c='dimmed'>Nobody else has access.</Text>}
      </Stack>
    </Stack>
  );
}
