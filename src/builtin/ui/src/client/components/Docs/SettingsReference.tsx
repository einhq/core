import { Alert, Anchor, Badge, Box, Group, Text, Title } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { type ConfigEntry } from '../../signals/config.ts';
import { useAccessIds, useConfig } from '@ein/ui/hooks';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';
import { DescriptionText, OwnerBadge, ReferenceIntro, ReferenceSection, settingAnchor, useScrollToHash } from './reference.tsx';

const SOURCE: Record<ConfigEntry['source'], { label: string; color: string }> = {
  default: { label: 'default', color: 'gray' },
  module: { label: 'chosen by a module', color: 'cyan' },
  environment: { label: 'from deployment', color: 'blue' },
  system: { label: 'set for everyone', color: 'violet' },
  user: { label: 'your own', color: 'grape' },
};

const shown = (value: string, emptyMeans?: string): string => value === '' ? emptyMeans ? `empty — ${emptyMeans}` : 'empty' : value;

/** What the entry holds now; a key says only whether it is set. */
const shownNow = (entry: ConfigEntry): string => entry.type === 'secret' ? (entry.source === 'default' ? 'not set' : 'set') : shown(entry.value, entry.emptyMeans);

function SettingEntry({ entry }: { entry: ConfigEntry }) {
  const source = SOURCE[entry.source];
  return (
    <Box
      id={settingAnchor(entry.key)}
      className='mrx-docs-target'
      py='sm'
      px='xs'
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <Group gap='xs' mb={4} wrap='wrap'>
        <Title order={3} fz='md'>{entry.label}</Title>
        <HighlightedCode inline language='text' code={entry.key} />
        <OwnerBadge owner={entry.owner} />
        <Badge size='sm' radius='sm' variant='light' color={entry.scope === 'user' ? 'grape' : 'gray'} tt='none'>
          {entry.scope === 'user' ? 'personal' : 'system'}
        </Badge>
      </Group>
      <Text size='sm' mb={6}>
        <DescriptionText text={entry.description} />
      </Text>
      <Group gap='lg' wrap='wrap'>
        <Text size='sm'>
          <Text span c='dimmed' size='sm' mr={4}>Now:</Text>
          <Text span ff='monospace' size='sm'>{shownNow(entry)}</Text>{' '}
          <Badge size='xs' radius='sm' variant='light' color={source.color} tt='none'>
            {entry.source === 'module' && entry.sourceModule ? `chosen by ${entry.sourceModule}` : source.label}
          </Badge>
        </Text>
        {entry.source !== 'default' && entry.type !== 'secret' && (
          <Text size='sm'>
            <Text span c='dimmed' size='sm' mr={4}>Default:</Text>
            <Text span ff='monospace' size='sm'>{shown(entry.default, entry.emptyMeans)}</Text>
          </Text>
        )}
        {entry.choices && (
          <Text size='sm'>
            <Text span c='dimmed' size='sm' mr={4}>One of:</Text>
            <Text span ff='monospace' size='sm'>{entry.choices.join(', ')}</Text>
          </Text>
        )}
        {entry.type !== 'string' && entry.type !== 'select' && (
          <Text size='sm'>
            <Text span c='dimmed' size='sm' mr={4}>Type:</Text>
            {entry.type}
          </Text>
        )}
      </Group>
      {(entry.restarts?.length || entry.restartNote) && (
        <Text size='xs' c='dimmed' mt={4}>
          {entry.restarts?.length ? `Changing it restarts ${entry.restarts.join(', ')}.` : ''} {entry.restartNote ?? ''}
        </Text>
      )}
    </Box>
  );
}

/**
 * Every setting the installation has — core's and each module's — with the value it has right
 * now and where that value came from. The settings pages change them; this says what they are.
 */
export function SettingsReference() {
  const { entries, loading, error } = useConfig();
  const access = useAccessIds();

  const groups = useMemo(() => {
    const byGroup = new Map<string, ConfigEntry[]>();
    for (const entry of entries) byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry]);
    return [...byGroup].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  useScrollToHash(!loading);

  return (
    <Box>
      <ReferenceIntro title='Settings'>
        The settings this installation has, with the value each has right now. System settings apply to everyone and {access?.admin
          ? (
            <>
              you change them under <Anchor component={Link} to='/settings'>Settings</Anchor>
            </>
          )
          : 'an administrator changes them'}; personal ones are yours, under{' '}
        <Anchor component={Link} to='/profile?tab=preferences'>Profile › Preferences</Anchor>. Each is an environment variable in every shell, except the keys to other
        services, which no shell sees and nothing shows. The same values are in the terminal:
      </ReferenceIntro>
      <HighlightedCode code={['config list', 'config get CFG_TRASH_RETENTION_DAYS', 'echo $HISTSIZE'].join('\n')} />

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} my='md'>
          {error.message}
        </Alert>
      )}
      {loading && <PageLoader />}

      <Box mt='lg'>
        {groups.map(([group, list]) => (
          <ReferenceSection key={group} id={`group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} title={group}>
            {list.map((entry) => <SettingEntry key={entry.key} entry={entry} />)}
          </ReferenceSection>
        ))}
      </Box>
    </Box>
  );
}
