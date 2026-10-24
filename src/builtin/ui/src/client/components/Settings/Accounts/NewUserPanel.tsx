import { Alert, Box, Button, Group, PasswordInput, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconUserPlus } from '@tabler/icons-react';
import { type FormEvent, useId, useState } from 'react';
import { accountNameProblem, emailProblem, type GroupEntry, normalizeEmail, suggestUsername, type UserCreated, type UserEntry } from '@ein/api';
import { useConfig } from '../../../hooks/useConfig.ts';
import { displayName, formatGroupList, isPersonalGroup, newUserGroups, parseGroupList } from '../../../lib/accounts.ts';
import { describeNodeError } from '../../../lib/access.ts';
import { shq } from '../../../lib/shquote.ts';
import { notify } from '../../../signals/notify.ts';
import { Checklist, type ChecklistItem } from './Checklist.tsx';
import { asSentence } from './PanelParts.tsx';
import type { Accounts } from './useAccounts.ts';

type NewUserPanelProps = {
  users: UserEntry[];
  groups: GroupEntry[];
  run: Accounts['run'];
  /** The account is made; `passwordError` says why its password could not be set, when it could not. */
  onCreated: (username: string, passwordError?: string) => void;
  onCancel: () => void;
};

/**
 * The form for a new account: the person's name and e-mail address, a username suggested from
 * them (`suggestUsername`) until one is typed, an optional password, and its groups, which start
 * as the default groups for new users. The groups not offered here (the defaults
 * that are someone's own, or the guest's) are passed on as they are.
 */
export function NewUserPanel({ users, groups, run, onCreated, onCancel }: NewUserPanelProps) {
  const { entries, loading } = useConfig('system');
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  // Null while the username follows the suggestion; what was typed once someone types one.
  const [typedUsername, setTypedUsername] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  // Null until a box is clicked: the defaults stand.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the account is made, the lists hold its name; it is not taken by anyone else.
  const [made, setMade] = useState(false);

  const defaultsEntry = entries.find((entry) => entry.key === 'CFG_DEFAULT_USER_GROUPS');
  const defaults = defaultsEntry ? parseGroupList(defaultsEntry.value) : [];
  const offered = groups.filter((group) => group.role !== 'guests' && !isPersonalGroup(group, users));
  // The group everyone is in is shown ticked, not offered as a choice.
  const choices = offered.filter((group) => group.role !== 'everyone').map((group) => group.groupname);
  const chosen = picked ?? defaults.filter((name) => choices.includes(name));

  // A username is taken by an account or a group: the account's own group is named like it.
  const taken = (candidate: string) => users.some((user) => user.username === candidate) || groups.some((group) => group.groupname === candidate);
  const address = normalizeEmail(email);
  const suggested = suggestUsername(title, address, taken) ?? '';
  const username = typedUsername ?? suggested;
  const name = username.trim();
  const problem = made ? undefined : accountNameProblem(name) ?? (taken(name) ? 'already taken' : undefined);
  const emailIssue = made || !address ? undefined : emailProblem(address) ?? (users.some((user) => user.email === address) ? 'another account has this address' : undefined);
  const mismatch = repeat !== '' && repeat !== password;
  // Why "Create user" can't be pressed, said under it.
  const blocker = emailIssue
    ? asSentence(emailIssue)
    : !name
    ? 'Choose a username'
    : problem
    ? asSentence(problem)
    : password && !repeat
    ? 'Repeat the password'
    : password !== repeat
    ? 'The passwords do not match'
    : undefined;
  const blockerId = useId();

  const toggle = (groupname: string, join: boolean) => setPicked(join ? [...chosen, groupname] : chosen.filter((each) => each !== groupname));

  const items = offered.map((group): ChecklistItem => {
    const everyone = group.role === 'everyone';
    const label = displayName(group);
    return {
      value: group.groupname,
      label,
      description: label === group.groupname ? undefined : group.groupname,
      checked: everyone || chosen.includes(group.groupname),
      disabled: everyone,
      note: everyone ? 'everyone who signs in' : undefined,
    };
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setEmailTouched(true);
    if (blocker) return;
    setBusy(true);
    setError(null);
    // Without the setting or a choice made here, the server applies its own defaults.
    const groupsFlag = defaultsEntry || picked ? ` --groups=${shq(formatGroupList(newUserGroups(defaults, choices, chosen)))}` : '';
    const titleFlag = title.trim() ? ` --title=${shq(title.trim())}` : '';
    const emailFlag = address ? ` --email=${shq(address)}` : '';
    let created: UserCreated;
    try {
      created = await run<UserCreated>(`user-create ${shq(name)}${titleFlag}${emailFlag}${groupsFlag}`);
      setMade(true);
    } catch (err) {
      setError(describeNodeError(err));
      setBusy(false);
      return;
    }
    let passwordError: string | undefined;
    if (password) {
      try {
        await run(`user-passwd ${shq(created.username)} --new-password=${shq(password)}`);
      } catch (err) {
        passwordError = describeNodeError(err);
      }
    }
    notify({ message: `Created ${created.username}.`, color: 'green' });
    onCreated(created.username, passwordError);
  };

  return (
    <Stack gap='lg'>
      <Box>
        <Title order={3}>New user</Title>
        <Text size='sm' c='dimmed'>Someone who signs in with a name and password of their own.</Text>
      </Box>

      <Stack component='form' gap='md' onSubmit={submit}>
        <Stack gap='md' maw={520}>
          <TextInput
            label='Name'
            placeholder='Anna Andersson'
            autoComplete='off'
            autoFocus
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <TextInput
            label='E-mail'
            description='They can sign in with it instead of the username.'
            type='email'
            placeholder='anna@example.com'
            autoComplete='off'
            value={email}
            disabled={busy}
            error={emailTouched && emailIssue ? asSentence(emailIssue) : undefined}
            onChange={(event) => setEmail(event.currentTarget.value)}
            onBlur={() => setEmailTouched(true)}
          />
          <TextInput
            label='Username'
            description="Suggested from the name. Lower case; it can't be changed later."
            required
            autoComplete='off'
            value={username}
            disabled={busy}
            error={touched && problem ? asSentence(problem) : undefined}
            onChange={(event) => {
              setTypedUsername(event.currentTarget.value);
              if (event.currentTarget.value) setTouched(true);
            }}
            onBlur={() => setTouched(true)}
          />
          <Stack gap={6}>
            <SimpleGrid type='container' cols={{ base: 1, '420px': 2 }} spacing='sm'>
              <PasswordInput
                label='Password'
                autoComplete='new-password'
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.currentTarget.value)}
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
            <Text size='xs' c='dimmed'>Leave the password empty to set it later — they can't sign in until then.</Text>
          </Stack>
        </Stack>

        <Stack gap={6}>
          <Text size='sm' fw={500}>Groups</Text>
          {/* The order is set once the default groups are known, ticked first. */}
          <Checklist items={items} onToggle={toggle} label='Groups' what='groups' resetKey={loading ? 'loading' : 'loaded'} disabled={busy} />
        </Stack>

        {error && <Alert color='red' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setError(null)}>{error}</Alert>}

        <Stack gap={6}>
          <Group gap='sm'>
            <Button
              type='submit'
              leftSection={<IconUserPlus size={16} />}
              loading={busy}
              disabled={touched && !!blocker}
              aria-describedby={touched && blocker ? blockerId : undefined}
            >
              Create user
            </Button>
            <Button variant='default' disabled={busy} onClick={onCancel}>Cancel</Button>
          </Group>
          {touched && blocker && <Text id={blockerId} size='xs' c='dimmed'>{blocker}</Text>}
        </Stack>
      </Stack>
    </Stack>
  );
}
