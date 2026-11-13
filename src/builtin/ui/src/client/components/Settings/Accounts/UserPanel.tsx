import { ActionIcon, Anchor, Badge, Box, Button, Divider, Group, Loader, PasswordInput, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconDeviceFloppy, IconKey, IconLink, IconLinkOff, IconLock, IconLockOpen, IconTrash } from '@tabler/icons-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { emailProblem, normalizeEmail } from '@ein/api';
import type { GroupEntry, MembershipChanged, PrimaryGroupSet, SessionEntry, UserDeleted, UserEntry, UserInactive, UserInvite, UserUpdated } from '@ein/api';
import { accountOption, accountStatus, displayName, isPersonalGroup, membershipOf, personalGroupOf, signedIn } from '../../../lib/accounts.ts';
import { describeNodeError } from '../../../lib/access.ts';
import { copyText } from '../../../lib/clipboard.ts';
import { countOf } from '../../../lib/count-of.ts';
import { inviteUrl } from '../../../lib/invite.ts';
import { expiryText } from '../../../lib/share-link.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { notify } from '../../../signals/notify.ts';
import { AccountAvatar } from './AccountAvatar.tsx';
import { Checklist, type ChecklistItem } from './Checklist.tsx';
import { asSentence, DeleteConfirm, Done, Note, PanelHeader, PanelSection, useInlineConfirm } from './PanelParts.tsx';
import type { Accounts } from './useAccounts.ts';
import { formatDateTime } from '../../../lib/datetime.ts';

type UserPanelProps = {
  user: UserEntry;
  users: UserEntry[];
  groups: GroupEntry[];
  sessions: SessionEntry[];
  run: Accounts['run'];
  /** Why setting the password failed as the account was made, said in its Password section. */
  passwordError?: string;
  /** After the account is deleted. */
  onDeleted: () => void;
  /** Opens the Permissions tab, where visitors are let in. */
  onOpenPermissions: () => void;
};

const ORIGIN: Record<SessionEntry['origin'], string> = { web: 'In the browser', ssh: 'Over SSH', terminal: 'In a terminal' };

const sessionLine = (session: SessionEntry): string =>
  `${ORIGIN[session.origin]}${session.from ? ` from ${session.from}` : ''}, since ${formatDateTime(session.since, { dateStyle: 'medium', timeStyle: 'short' })}`;

const StatusBadge = ({ color, children }: { color: string; children: string }) => <Badge size='sm' variant='light' color={color} tt='none'>{children}</Badge>;

/** The teal mark of an open session. */
const SessionDot = () => <Box component='span' w={6} h={6} bg='var(--mantine-color-teal-filled)' style={{ display: 'inline-block', flex: 'none', borderRadius: '50%' }} />;

/**
 * One account, edited in place: its profile, its groups and primary group, its password and a
 * link to choose one with, where it is signed in now, and disabling or deleting it. The administrator is never disabled or
 * deleted; the guest is shown only, since it has no password and its groups give it nothing.
 */
export function UserPanel({ user, users, groups, sessions, run, passwordError, onDeleted, onOpenPermissions }: UserPanelProps) {
  const status = accountStatus(user);
  const open = signedIn(user, sessions);

  const badges = [
    user.role === 'administrator' && <StatusBadge key='administrator' color='marine'>Administrator</StatusBadge>,
    user.role === 'guest' && <StatusBadge key='guest' color='gray'>Guest</StatusBadge>,
    status === 'disabled' && <StatusBadge key='disabled' color='gray'>Disabled</StatusBadge>,
    status === 'needs-password' && <StatusBadge key='password' color='yellow'>Needs a password</StatusBadge>,
    open.length > 0 && <Badge key='signed-in' size='sm' variant='light' color='teal' tt='none' leftSection={<SessionDot />}>Signed in now</Badge>,
  ].filter(Boolean);

  const header = (
    <PanelHeader
      avatar={<AccountAvatar user={user} size={64} />}
      title={displayName(user)}
      meta={user.email ? [`${user.username}, uid ${user.uid}`, user.email] : `${user.username}, uid ${user.uid}`}
      badges={badges.length > 0 ? badges : undefined}
    />
  );

  if (user.role === 'guest') {
    return (
      <Stack gap='lg'>
        {header}
        <Divider />
        <Text size='sm' c='dimmed'>
          Visitors browse as guest when <b>Visitors may browse</b> is on in{' '}
          <Anchor component='button' type='button' size='sm' onClick={onOpenPermissions}>Permissions</Anchor>. It has no password and its groups give it nothing.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap='lg'>
      {header}
      <Divider />
      <ProfileSection user={user} users={users} run={run} />
      <Divider />
      <GroupsSection user={user} users={users} groups={groups} signedInNow={open.length > 0} run={run} />
      <Divider />
      <PasswordSection user={user} run={run} initialError={passwordError} />
      <Divider />
      <InviteSection user={user} />
      <Divider />
      <SignInSection user={user} users={users} groups={groups} sessions={open} run={run} onDeleted={onDeleted} />
    </Stack>
  );
}

type SectionProps = { user: UserEntry; run: Accounts['run'] };

function ProfileSection({ user, users, run }: SectionProps & { users: UserEntry[] }) {
  const [title, setTitle] = useState(user.title ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [description, setDescription] = useState(user.description ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each field follows its saved value when that changes, here or in a terminal.
  useEffect(() => setTitle(user.title ?? ''), [user.title]);
  useEffect(() => setEmail(user.email ?? ''), [user.email]);
  useEffect(() => setDescription(user.description ?? ''), [user.description]);

  const address = normalizeEmail(email);
  const emailIssue = !address || address === user.email
    ? undefined
    : emailProblem(address) ?? (users.some((other) => other.username !== user.username && other.email === address) ? 'another account has this address' : undefined);
  const dirty = title.trim() !== (user.title ?? '') || address !== (user.email ?? '') || description.trim() !== (user.description ?? '');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await run<UserUpdated>(
        `user-update ${shq(user.username)} --name=${shq(title.trim())} --email=${shq(address)} --description=${shq(description.trim())}`,
      );
      setSaved(true);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title='Profile' lead='How the account is named to others.' error={error} onDismiss={() => setError(null)}>
      <Stack component='form' gap='sm' maw={520} onSubmit={save}>
        <TextInput
          label='Display name'
          placeholder={user.username}
          value={title}
          disabled={busy}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setSaved(false);
          }}
        />
        <TextInput
          label='E-mail'
          description='They can sign in with it instead of the username.'
          type='email'
          value={email}
          disabled={busy}
          error={emailIssue && asSentence(emailIssue)}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
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
          <Button type='submit' leftSection={<IconDeviceFloppy size={16} />} loading={busy} disabled={!dirty || !title.trim() || !!emailIssue}>Save profile</Button>
          {saved && !dirty && <Done>Saved</Done>}
        </Group>
      </Stack>
    </PanelSection>
  );
}

const personalLabel = (group: GroupEntry): string => `${group.groupname} (personal)`;

function GroupsSection({ user, users, groups, signedInNow, run }: SectionProps & { users: UserEntry[]; groups: GroupEntry[]; signedInNow: boolean }) {
  const name = displayName(user);
  // The groups whose membership is changing, each with the state it is changing to.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [primaryBusy, setPrimaryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const own = personalGroupOf(user, groups);
  const primary = groups.find((group) => group.gid === user.gid);
  // Their own group and the shared ones; another account's own group only while this one is in it.
  // The guest's group gives nothing.
  const listed = groups.filter((group) => group.role !== 'guests' && (group === own || !isPersonalGroup(group, users) || membershipOf(user, group) !== 'none'));
  const primaryOptions = groups
    .filter((group) => group === own || group === primary || (group.role !== 'guests' && !isPersonalGroup(group, users)))
    .map((group) => isPersonalGroup(group, users) ? { value: group.groupname, label: personalLabel(group) } : accountOption(group));

  // Why a box reads as it does: whose own group it is, or how the account is in it without a link.
  const noteFor = (group: GroupEntry, kind: ReturnType<typeof membershipOf>): string | undefined => {
    if (group === own) return kind === 'primary' ? 'their own group, primary' : 'their own group';
    if (kind === 'primary') return 'primary group';
    if (group.role === 'everyone') return kind === 'none' ? 'taken out of what is shared with everyone' : 'everyone who signs in';
    if (isPersonalGroup(group, users)) return `${group.groupname}'s own group`;
    return undefined;
  };

  const items = listed.map((group): ChecklistItem => {
    const kind = membershipOf(user, group);
    const target = pending[group.groupname];
    const title = displayName(group);
    return {
      value: group.groupname,
      label: title,
      description: title === group.groupname ? undefined : group.groupname,
      checked: target ?? kind !== 'none',
      disabled: kind === 'primary',
      note: noteFor(group, kind),
      busy: target !== undefined,
    };
  });

  const apply = async (group: GroupEntry, join: boolean) => {
    setError(null);
    setPending((current) => ({ ...current, [group.groupname]: join }));
    try {
      await run<MembershipChanged>(`group-${join ? 'add' : 'remove'}-member ${shq(group.groupname)} ${shq(user.username)}`);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setPending(({ [group.groupname]: _done, ...rest }) => rest);
    }
  };

  const toggle = (groupname: string, join: boolean) => {
    const group = groups.find((each) => each.groupname === groupname);
    if (group) apply(group, join);
  };

  const setPrimary = async (groupname: string) => {
    if (groupname === primary?.groupname) return;
    setPrimaryBusy(true);
    setError(null);
    try {
      await run<PrimaryGroupSet>(`user-set-primary-group ${shq(user.username)} ${shq(groupname)}`);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setPrimaryBusy(false);
    }
  };

  return (
    <PanelSection title='Groups' lead='What they may see and change, beyond their own things.' error={error} onDismiss={() => setError(null)}>
      <Checklist items={items} onToggle={toggle} label={`Groups ${name} is in`} what='groups' resetKey={user.username} />

      <Select
        label='Primary group'
        description='A group they are always in. What they create takes the group of its folder; this one is used where nothing else names a group.'
        maw={360}
        searchable
        allowDeselect={false}
        nothingFoundMessage='No group by that name'
        data={primaryOptions}
        value={primary?.groupname ?? null}
        placeholder={primary ? undefined : `gid ${user.gid}, which no group has`}
        disabled={primaryBusy}
        rightSection={primaryBusy ? <Loader size={14} /> : undefined}
        onChange={(next) => next && setPrimary(next)}
      />

      <Note>
        {signedInNow ? `${name} is signed in now; group changes apply the next time they sign in.` : `Group changes apply the next time ${name} signs in.`}
      </Note>
    </PanelSection>
  );
}

function PasswordSection({ user, run, initialError }: SectionProps & { initialError?: string }) {
  const name = displayName(user);
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const mismatch = repeat !== '' && repeat !== next;
  const waiting = user.mustResetPassword || user.hasPassword === false;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!next || next !== repeat) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await run(`user-passwd ${shq(user.username)} --new-password=${shq(next)}`);
      setNext('');
      setRepeat('');
      setDone(true);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection
      title='Password'
      lead={waiting
        ? `${name} can't sign in until a password is set: set one here, or send them a sign-in link to choose their own.`
        : `Set a new password for ${name}. Their current one stops working.`}
      error={error}
      onDismiss={() => setError(null)}
    >
      <Stack component='form' gap='sm' maw={520} onSubmit={submit}>
        <SimpleGrid type='container' cols={{ base: 1, '420px': 2 }} spacing='sm'>
          <PasswordInput
            label='New password'
            autoComplete='new-password'
            value={next}
            disabled={busy}
            onChange={(event) => {
              setNext(event.currentTarget.value);
              setDone(false);
            }}
          />
          <PasswordInput
            label='Repeat'
            autoComplete='new-password'
            value={repeat}
            disabled={busy}
            error={mismatch && 'Does not match'}
            onChange={(event) => setRepeat(event.currentTarget.value)}
          />
        </SimpleGrid>
        <Group gap='sm'>
          <Button type='submit' variant='default' leftSection={<IconKey size={16} />} loading={busy} disabled={!next || next !== repeat}>
            Set password
          </Button>
          {done && <Done>Password set</Done>}
        </Group>
      </Stack>
    </PanelSection>
  );
}

/**
 * The account's sign-in link (`user-invite`): made, its address copied to send however the
 * administrator likes, made anew or taken away. Whoever opens it chooses the account's password.
 */
function InviteSection({ user }: { user: UserEntry }) {
  const name = displayName(user);
  const [invite, setInvite] = useState<UserInvite | null>(null);
  const [busy, setBusy] = useState<'new' | 'off' | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Read again when the password changes, which a link chosen with it does as it spends it.
  useEffect(() => {
    let cancelled = false;
    execCommand<UserInvite>(`user-invite ${shq(user.username)}`).then(
      (found) => !cancelled && setInvite(found),
      (err) => !cancelled && setError(describeNodeError(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [user.username, user.hasPassword, user.mustResetPassword]);

  const change = async (what: 'new' | 'off') => {
    setBusy(what);
    setError(null);
    try {
      setInvite(await execCommand<UserInvite>(`user-invite ${shq(user.username)} --${what}`));
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setBusy(null);
    }
  };

  const url = invite?.token ? inviteUrl(globalThis.location.origin, invite.token) : undefined;
  const copy = async () => {
    if (!url) return;
    if (!(await copyText(url, input.current))) {
      notify({ message: 'The browser would not copy the link: it is selected for you to copy.', color: 'yellow' });
      return;
    }
    notify({ message: 'Link copied to clipboard' });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <PanelSection
      title='Sign-in link'
      lead={`A link ${name} opens to choose their own password, which also shows them their username. Send it however you like; it works once.`}
      error={error}
      onDismiss={() => setError(null)}
    >
      {url && (
        <Stack gap={6} maw={520}>
          <TextInput
            ref={input}
            readOnly
            value={url}
            onClick={copy}
            aria-label='The sign-in link; click to copy it'
            rightSectionPointerEvents='all'
            rightSection={
              <Tooltip label={copied ? 'Copied' : 'Copy link'} withArrow>
                <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} onClick={copy} aria-label='Copy link'>
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', cursor: 'pointer' } }}
          />
          <Text size='xs' c='dimmed'>{expiryText(invite?.expiresAt)}</Text>
        </Stack>
      )}
      <Group gap='sm'>
        <Button
          variant='default'
          leftSection={<IconLink size={16} />}
          loading={busy === 'new'}
          disabled={invite === null || busy !== null || user.inactive}
          onClick={() => change('new')}
        >
          {url ? 'Make a new link' : 'Make a sign-in link'}
        </Button>
        {url && (
          <Button variant='subtle' color='red' leftSection={<IconLinkOff size={16} />} loading={busy === 'off'} disabled={busy !== null} onClick={() => change('off')}>
            Turn off
          </Button>
        )}
      </Group>
      {user.inactive && <Note>Enable sign-in before making a link.</Note>}
      {url && <Note>A new link stops this one working.</Note>}
    </PanelSection>
  );
}

type SignInSectionProps = SectionProps & {
  users: UserEntry[];
  groups: GroupEntry[];
  /** The account's open sessions. */
  sessions: SessionEntry[];
  onDeleted: () => void;
};

function SignInSection({ user, users, groups, sessions, run, onDeleted }: SignInSectionProps) {
  const name = displayName(user);
  const [toggling, setToggling] = useState(false);
  const confirm = useInlineConfirm();
  const [deleting, setDeleting] = useState(false);
  const administrator = users.find((each) => each.role === 'administrator')?.username ?? 'admin';
  const [heir, setHeir] = useState<string | null>(administrator);
  const [error, setError] = useState<string | null>(null);

  const sessionList = sessions.length > 0 && (
    <Stack gap={4}>
      <Text size='sm' fw={500}>Signed in now</Text>
      {sessions.map((session) => (
        <Group key={session.tty} gap={8} wrap='nowrap'>
          <SessionDot />
          <Text size='sm' c='dimmed'>{sessionLine(session)}</Text>
        </Group>
      ))}
    </Stack>
  );

  if (user.role === 'administrator') {
    return <PanelSection title='Sign-in and removal' lead="The administrator can't be disabled or deleted.">{sessionList}</PanelSection>;
  }

  const heirs = users.filter((each) => each.username !== user.username && each.role !== 'guest').map(accountOption);
  // Their own group goes with them unless someone else is in it.
  const own = personalGroupOf(user, groups);
  const othersInOwn = own !== undefined && users.some((each) => each.username !== user.username && membershipOf(each, own) !== 'none');

  const toggle = async () => {
    setToggling(true);
    setError(null);
    try {
      await run<UserInactive>(`${user.inactive ? 'user-enable' : 'user-disable'} ${shq(user.username)}`);
    } catch (err) {
      setError(describeNodeError(err));
    } finally {
      setToggling(false);
    }
  };

  const remove = async () => {
    if (!heir) return;
    setDeleting(true);
    setError(null);
    try {
      const deleted = await run<UserDeleted>(`user-delete ${shq(user.username)} --to=${shq(heir)}`);
      const kept = deleted.group && !deleted.group.deleted ? ` Their group ${deleted.group.groupname} was kept${othersInOwn ? ': others are still in it' : ''}.` : '';
      notify({ message: `Deleted ${deleted.deleted}. ${countOf(deleted.owned, 'item', 'items')} passed to ${deleted.to}.${kept}`, color: 'green' });
      onDeleted();
    } catch (err) {
      setError(describeNodeError(err));
      setDeleting(false);
    }
  };

  return (
    <PanelSection
      title='Sign-in and removal'
      lead={user.inactive
        ? `${name} can't sign in. Enabling lets them sign in again with their password.`
        : `Disabling signs ${name} out everywhere and stops them signing in. Nothing they own is changed.`}
      error={error}
      onDismiss={() => setError(null)}
    >
      {sessionList}
      <Group gap='sm'>
        <Button
          variant='default'
          leftSection={user.inactive ? <IconLockOpen size={16} /> : <IconLock size={16} />}
          loading={toggling}
          onClick={toggle}
        >
          {user.inactive ? 'Enable sign-in' : 'Disable sign-in'}
        </Button>
        {!confirm.open && (
          <Button ref={confirm.opener} variant='outline' color='red' leftSection={<IconTrash size={16} />} onClick={confirm.show}>
            Delete account…
          </Button>
        )}
      </Group>

      {confirm.open && (
        <DeleteConfirm
          heirs={heirs}
          heir={heir}
          onHeir={setHeir}
          action={`Delete ${user.username}`}
          busy={deleting}
          onConfirm={remove}
          onCancel={confirm.cancel}
        >
          Deleting {user.username} removes their home folder and everything in it.{' '}
          {own && (othersInOwn ? `Their group ${own.groupname} stays, since others are in it. ` : `Their group ${own.groupname} goes too. `)}
          Everything they own elsewhere passes to:
        </DeleteConfirm>
      )}
    </PanelSection>
  );
}
