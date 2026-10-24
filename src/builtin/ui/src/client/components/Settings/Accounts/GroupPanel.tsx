import { Anchor, Avatar, Badge, Box, Button, Divider, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { IconDeviceFloppy, IconTrash, IconUser } from '@tabler/icons-react';
import { type FormEvent, Fragment, type ReactNode, useEffect, useState } from 'react';
import type { GroupDeleted, GroupEntry, GroupRole, GroupUpdated, MembershipChanged, UserEntry } from '@ein/api';
import { accountOption, displayName, isPersonalGroup, membershipOf } from '../../../lib/accounts.ts';
import { describeNodeError } from '../../../lib/access.ts';
import { countOf } from '../../../lib/count-of.ts';
import { shq } from '../../../lib/shquote.ts';
import { notify } from '../../../signals/notify.ts';
import { AccountAvatar } from './AccountAvatar.tsx';
import { GroupAvatar } from '../../Identity/GroupAvatar.tsx';
import { Checklist, type ChecklistItem } from './Checklist.tsx';
import { DeleteConfirm, Done, Note, PanelHeader, PanelSection, useInlineConfirm } from './PanelParts.tsx';
import type { Accounts } from './useAccounts.ts';

type GroupPanelProps = {
  group: GroupEntry;
  users: UserEntry[];
  groups: GroupEntry[];
  run: Accounts['run'];
  /** After the group is deleted. */
  onDeleted: () => void;
  onOpenUser: (username: string) => void;
};

/** What a group made at boot is for, said where it is edited. */
const ROLE_TEXT: Record<GroupRole, (name: string) => string> = {
  administrators: (name) =>
    `The administrator's own group, as root's is on Linux. Being in ${name} does not make anyone an administrator, and gives no write to the system's own folders and settings.`,
  everyone: (name) => `Every account that signs in belongs to ${name}. Sharing with ${name} shares with all of them.`,
  ssh: () => 'Its members may use ssh, scp and ssh-copy-id to reach other machines.',
  sudo: () =>
    'Its members may become the administrator for one sign-in by choosing Administer in the account menu and entering their password again. Taking someone out of the group ends that at once.',
  guests: () => "The guest account's own group. Visitors browse as the guest, so what this group may see, they may see.",
};

/** Everyone who belongs to `group`, linked, by primary group or by signing in. */
const memberCount = (group: GroupEntry, users: UserEntry[]): number => users.filter((user) => membershipOf(user, group) !== 'none').length;

/** `Anna Andersson, Bo Berg and Cecilia`, of names or of links. */
const listOf = (items: ReactNode[]): ReactNode =>
  items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && (index === items.length - 1 ? ' and ' : ', ')}
      {item}
    </Fragment>
  ));

/**
 * One group, edited in place: its title and description, who is in it, and deleting it. Built-in
 * groups say what they are for and cannot be deleted; `everyone` lists nobody to add or remove,
 * since every account that signs in is in it.
 */
export function GroupPanel({ group, users, groups, run, onDeleted, onOpenUser }: GroupPanelProps) {
  const name = group.groupname;
  const owner = isPersonalGroup(group, users) ? users.find((user) => user.username === name) : undefined;

  return (
    <Stack gap='lg'>
      <PanelHeader
        avatar={<GroupAvatar role={group.role} size={64} />}
        title={displayName(group)}
        meta={`${name}, gid ${group.gid}`}
        badges={
          <>
            {group.role && <Badge size='sm' variant='outline' color='gray' tt='none'>Built in</Badge>}
            {owner && <Badge size='sm' variant='light' color='gray' tt='none'>{owner.username}'s own group</Badge>}
            <Badge size='sm' variant='default' tt='none'>{countOf(memberCount(group, users), 'member', 'members')}</Badge>
          </>
        }
      />
      {group.role && <Note>{ROLE_TEXT[group.role](name)}</Note>}
      <Divider />
      <ProfileSection group={group} run={run} />
      <Divider />
      <MembersSection group={group} users={users} run={run} onOpenUser={onOpenUser} />
      <Divider />
      <DeleteSection group={group} users={users} groups={groups} run={run} onDeleted={onDeleted} />
    </Stack>
  );
}

type SectionProps = { group: GroupEntry; run: Accounts['run'] };

function ProfileSection({ group, run }: SectionProps) {
  const [title, setTitle] = useState(group.title ?? '');
  const [description, setDescription] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each field follows its saved value when that changes, here or in a terminal.
  useEffect(() => setTitle(group.title ?? ''), [group.title]);
  useEffect(() => setDescription(group.description ?? ''), [group.description]);

  const dirty = title.trim() !== (group.title ?? '') || description.trim() !== (group.description ?? '');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await run<GroupUpdated>(`group-update ${shq(group.groupname)} --title=${shq(title.trim())} --description=${shq(description.trim())}`);
      setSaved(true);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title='Profile' lead='How the group is named where things are shared with it.' error={error} onDismiss={() => setError(null)}>
      <Stack component='form' gap='sm' maw={520} onSubmit={save}>
        <TextInput
          label='Title'
          placeholder={group.groupname}
          value={title}
          disabled={busy}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setSaved(false);
          }}
        />
        <Textarea
          label='Description'
          autosize
          minRows={2}
          value={description}
          disabled={busy}
          onChange={(event) => {
            setDescription(event.currentTarget.value);
            setSaved(false);
          }}
        />
        <Group gap='sm'>
          <Button type='submit' leftSection={<IconDeviceFloppy size={16} />} loading={busy} disabled={!dirty}>Save profile</Button>
          {saved && !dirty && <Done>Saved</Done>}
        </Group>
      </Stack>
    </PanelSection>
  );
}

function MembersSection({ group, users, run, onOpenUser }: SectionProps & { users: UserEntry[]; onOpenUser: (username: string) => void }) {
  // The accounts whose membership is changing, each with the state it is changing to.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  if (group.role === 'everyone') {
    return <PanelSection title='Members' lead={`Everyone who signs in belongs to ${group.groupname}; there is nobody to add or remove.`} />;
  }

  const byName = new Map(users.map((user) => [user.username, user]));
  const primaryOf = users.filter((user) => membershipOf(user, group) === 'primary');
  // The guest only while it is linked here, to be taken out; its groups give it nothing.
  const people = users.filter((user) => user.role !== 'guest' || membershipOf(user, group) !== 'none');
  // A link left to an account that no longer exists, listed by its name to be taken out.
  const gone = (group.members ?? []).filter((username) => !byName.has(username));

  const items: ChecklistItem[] = [
    ...people.map((user): ChecklistItem => {
      const kind = membershipOf(user, group);
      const target = pending[user.username];
      const title = displayName(user);
      return {
        value: user.username,
        label: title,
        description: title === user.username ? undefined : user.username,
        avatar: <AccountAvatar user={user} size={24} />,
        checked: target ?? kind !== 'none',
        disabled: kind === 'primary',
        note: kind === 'primary' ? 'primary group' : undefined,
        busy: target !== undefined,
      };
    }),
    ...gone.map((username): ChecklistItem => ({
      value: username,
      label: username,
      avatar: (
        <Avatar size={24} radius='md'>
          <IconUser size={14} />
        </Avatar>
      ),
      checked: pending[username] ?? true,
      note: 'no longer an account',
      busy: username in pending,
    })),
  ];

  const apply = async (username: string, join: boolean) => {
    setError(null);
    setPending((current) => ({ ...current, [username]: join }));
    try {
      await run<MembershipChanged>(`group-${join ? 'add' : 'remove'}-member ${shq(group.groupname)} ${shq(username)}`);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setPending(({ [username]: _done, ...rest }) => rest);
    }
  };

  return (
    <PanelSection title='Members' lead='Changes apply the next time each person signs in.' error={error} onDismiss={() => setError(null)}>
      <Checklist items={items} onToggle={apply} label={`Members of ${group.groupname}`} what='people' resetKey={group.groupname} />

      {primaryOf.length > 0 && (
        <Note>
          Primary members leave only when their primary group is changed, on their own page: {listOf(primaryOf.map((user) => (
            <Anchor
              key={user.username}
              component='button'
              type='button'
              size='sm'
              onClick={() => onOpenUser(user.username)}
            >
              {displayName(user)}
            </Anchor>
          )))}.
        </Note>
      )}
    </PanelSection>
  );
}

function DeleteSection({ group, users, groups, run, onDeleted }: SectionProps & { users: UserEntry[]; groups: GroupEntry[]; onDeleted: () => void }) {
  const confirm = useInlineConfirm();
  const [busy, setBusy] = useState(false);
  const administrators = groups.find((each) => each.role === 'administrators')?.groupname ?? 'admin';
  const [heir, setHeir] = useState<string | null>(administrators);
  const [error, setError] = useState<string | null>(null);

  if (group.role) return <PanelSection title='Delete' lead="Built-in groups can't be deleted." />;

  const heirs = groups.filter((each) => each.groupname !== group.groupname).map(accountOption);
  const primaryOf = users.filter((user) => user.gid === group.gid);

  const remove = async () => {
    if (!heir) return;
    setBusy(true);
    setError(null);
    try {
      const deleted = await run<GroupDeleted>(`group-delete ${shq(group.groupname)} --to=${shq(heir)}${primaryOf.length > 0 ? ' --force' : ''}`);
      notify({ message: `Deleted ${deleted.deleted}. ${countOf(deleted.owned, 'item', 'items')} passed to ${deleted.to}.`, color: 'green' });
      onDeleted();
    } catch (err) {
      setError(describeNodeError(err));
      setBusy(false);
    }
  };

  return (
    <PanelSection title='Delete' lead='Removes the group; nobody loses their account.' error={error} onDismiss={() => setError(null)}>
      {confirm.open
        ? (
          <DeleteConfirm
            heirs={heirs}
            heir={heir}
            onHeir={setHeir}
            action={`Delete ${group.groupname}`}
            busy={busy}
            onConfirm={remove}
            onCancel={confirm.cancel}
          >
            Deleting {group.groupname} removes the group.{' '}
            {primaryOf.length > 0 && <>It is the primary group of {listOf(primaryOf.map(displayName))}; they go back to their own groups.{' '}</>}
            What it owns passes to the group:
          </DeleteConfirm>
        )
        : (
          <Box>
            <Button ref={confirm.opener} variant='outline' color='red' leftSection={<IconTrash size={16} />} onClick={confirm.show}>Delete group…</Button>
          </Box>
        )}
    </PanelSection>
  );
}
