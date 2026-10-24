import { Alert, Box, Button, Group, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconUsersPlus } from '@tabler/icons-react';
import { type FormEvent, useId, useState } from 'react';
import { accountNameProblem, type GroupCreated, type GroupEntry, type MembershipChanged, type UserEntry } from '@ein/api';
import { displayName } from '../../../lib/accounts.ts';
import { describeNodeError } from '../../../lib/access.ts';
import { shq } from '../../../lib/shquote.ts';
import { notify } from '../../../signals/notify.ts';
import { AccountAvatar } from './AccountAvatar.tsx';
import { Checklist, type ChecklistItem } from './Checklist.tsx';
import { asSentence } from './PanelParts.tsx';
import type { Accounts } from './useAccounts.ts';

type NewGroupPanelProps = {
  users: UserEntry[];
  groups: GroupEntry[];
  run: Accounts['run'];
  onCreated: (groupname: string) => void;
  onCancel: () => void;
};

/** The form for a new group: its name, title and description, and who is in it from the start. */
export function NewGroupPanel({ users, groups, run, onCreated, onCancel }: NewGroupPanelProps) {
  const [groupname, setGroupname] = useState('');
  const [touched, setTouched] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the group is made, the lists hold its name; it is not taken by another.
  const [made, setMade] = useState(false);

  const name = groupname.trim();
  const problem = made ? undefined : accountNameProblem(name) ?? (groups.some((group) => group.groupname === name) ? 'already taken' : undefined);
  // Why "Create group" can't be pressed, said under it.
  const blocker = !name ? 'Choose a name' : problem ? asSentence(problem) : undefined;
  const blockerId = useId();

  const toggle = (username: string, join: boolean) => setMembers((current) => join ? [...current, username] : current.filter((each) => each !== username));

  const items = users.filter((user) => user.role !== 'guest').map((user): ChecklistItem => {
    const label = displayName(user);
    return {
      value: user.username,
      label,
      description: label === user.username ? undefined : user.username,
      avatar: <AccountAvatar user={user} size={24} />,
      checked: members.includes(user.username),
    };
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (blocker) return;
    setBusy(true);
    setError(null);
    const titleFlag = title.trim() ? ` --title=${shq(title.trim())}` : '';
    const descriptionFlag = description.trim() ? ` --description=${shq(description.trim())}` : '';
    let created: GroupCreated;
    try {
      created = await run<GroupCreated>(`group-create ${shq(name)}${titleFlag}${descriptionFlag}`);
      setMade(true);
    } catch (err) {
      setError(describeNodeError(err));
      setBusy(false);
      return;
    }
    const failed: string[] = [];
    for (const username of members) {
      try {
        await run<MembershipChanged>(`group-add-member ${shq(created.groupname)} ${shq(username)}`);
      } catch (err) {
        failed.push(`${username}: ${describeNodeError(err)}`);
      }
    }
    notify(
      failed.length === 0
        ? { message: `Created ${created.groupname}.`, color: 'green' }
        : { message: `Created ${created.groupname}, but could not add ${failed.join('; ')}`, color: 'yellow' },
    );
    onCreated(created.groupname);
  };

  return (
    <Stack gap='lg'>
      <Box>
        <Title order={3}>New group</Title>
        <Text size='sm' c='dimmed'>Share a folder with a group, and everyone in it can see it.</Text>
      </Box>

      <Stack component='form' gap='md' onSubmit={submit}>
        <Stack gap='md' maw={520}>
          <TextInput
            label='Name'
            description="How commands and settings name it. It can't be changed later."
            placeholder='family'
            required
            autoComplete='off'
            autoFocus
            value={groupname}
            disabled={busy}
            error={touched && problem ? asSentence(problem) : undefined}
            onChange={(event) => {
              setGroupname(event.currentTarget.value);
              if (event.currentTarget.value) setTouched(true);
            }}
            onBlur={() => setTouched(true)}
          />
          <TextInput label='Title' placeholder='Family' value={title} disabled={busy} onChange={(event) => setTitle(event.currentTarget.value)} />
          <Textarea
            label='Description'
            autosize
            minRows={2}
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </Stack>

        <Stack gap={6}>
          <Text size='sm' fw={500}>Members</Text>
          <Checklist items={items} onToggle={toggle} label='Members' what='people' disabled={busy} />
          <Text size='xs' c='dimmed'>Optional. Anyone can be added later, here or on their own page.</Text>
        </Stack>

        {error && <Alert color='red' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setError(null)}>{error}</Alert>}

        <Stack gap={6}>
          <Group gap='sm'>
            <Button
              type='submit'
              leftSection={<IconUsersPlus size={16} />}
              loading={busy}
              disabled={touched && !!blocker}
              aria-describedby={touched && blocker ? blockerId : undefined}
            >
              Create group
            </Button>
            <Button variant='default' disabled={busy} onClick={onCancel}>Cancel</Button>
          </Group>
          {touched && blocker && <Text id={blockerId} size='xs' c='dimmed'>{blocker}</Text>}
        </Stack>
      </Stack>
    </Stack>
  );
}
