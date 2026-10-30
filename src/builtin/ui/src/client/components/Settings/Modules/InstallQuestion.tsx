import { Button, Group, Radio, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';
import { parseGroupList } from '../../../lib/accounts.ts';
import { GroupsMultiSelect } from '../AccountInputs.tsx';

type InstallQuestionProps = {
  /** The module, when its name is known; a repository's address installs whatever it holds. */
  name?: string;
  busy: boolean;
  /** Install it, for these groups; none for everyone. */
  onInstall: (groups: string[]) => void;
  onCancel: () => void;
};

/**
 * What Install asks before it installs: who the module is for, everyone or only some groups, whose
 * members alone (and administrators) then have its commands, its entries in the navigation and its
 * pages (`mod install --groups`). Asked where Install was pressed, taking the focus as it opens.
 */
export function InstallQuestion({ name, busy, onInstall, onCancel }: InstallQuestionProps) {
  const [who, setWho] = useState<'everyone' | 'groups'>('everyone');
  const [groups, setGroups] = useState('');
  const questionId = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const chosen = who === 'groups' ? parseGroupList(groups) : [];
  const what = name ?? 'the module';

  return (
    <Stack gap='xs' mt='xs'>
      <Radio.Group value={who} onChange={(next) => setWho(next as 'everyone' | 'groups')} aria-labelledby={questionId}>
        <Text id={questionId} size='sm' fw={500} mb={6}>Who is {what} for?</Text>
        <Stack gap={6}>
          <Radio ref={first} value='everyone' label='Everyone' disabled={busy} />
          <Radio
            value='groups'
            label='Only some groups'
            description='Their members and administrators get its commands, its entries in the navigation and its pages.'
            disabled={busy}
          />
        </Stack>
      </Radio.Group>
      {who === 'groups' && <GroupsMultiSelect value={groups} onChange={setGroups} placeholder='Choose groups' aria-label={`Groups ${what} is for`} disabled={busy} />}
      <Text size='xs' c='dimmed'>The modules it needs come with it, for everyone. Its panel changes who it is for later.</Text>
      <Group gap='xs'>
        <Button size='xs' leftSection={<IconDownload size={16} />} loading={busy} disabled={who === 'groups' && chosen.length === 0} onClick={() => onInstall(chosen)}>
          Install{name ? ` ${name}` : ''}
        </Button>
        <Button size='xs' variant='default' disabled={busy} onClick={onCancel}>Cancel</Button>
      </Group>
    </Stack>
  );
}
