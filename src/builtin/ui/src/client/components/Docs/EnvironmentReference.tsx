import { Alert, Anchor, Box, Group, Text } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { type EnvReference, useEnvReference } from '@ein/ui/hooks';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';
import { DescriptionText, envAnchor, OwnerBadge, ReferenceIntro, ReferenceSection, useScrollToHash } from './reference.tsx';

type Kind = EnvReference['kind'] | 'undescribed';

const SECTIONS: { kind: Kind; title: string; intro: string; showValue: boolean }[] = [
  {
    kind: 'option',
    title: 'Options for your shell',
    intro: 'Nobody sets these for you. Export one in a shell, or put it before a single command, to change how commands behave there.',
    showValue: true,
  },
  {
    kind: 'session',
    title: 'Your session',
    intro: 'Set for every shell you open, in the terminal panel, over SSH, and for each command the web interface runs. The values are the ones your shell has now.',
    showValue: true,
  },
  {
    kind: 'path',
    title: 'Where things are',
    intro: 'The layout of the tree, exported in /etc/bashrc so scripts can say $LOGS_PATH instead of spelling it out.',
    showValue: true,
  },
  {
    kind: 'system',
    title: 'Set at boot',
    intro: 'The rest of what boot exports for scripts: the built-in accounts and groups, and the host directories the files are on.',
    showValue: true,
  },
  {
    kind: 'pipeline',
    title: 'In a pipeline step',
    intro: 'Set for each step of a pipeline by the event that started it: what happened, and to which node.',
    showValue: false,
  },
  {
    kind: 'deployment',
    title: 'Deployment',
    intro:
      "Read once by the EiN process when it starts, from the container's environment — the host configuration an administrator edits. They are not in any shell, and their values are not shown here.",
    showValue: false,
  },
  {
    kind: 'undescribed',
    title: 'Also in your shell',
    intro: 'Set in your shell, but nothing describes them yet.',
    showValue: true,
  },
];

function EnvTable({ entries, showValue }: { entries: EnvReference[]; showValue: boolean }) {
  return (
    <Box>
      {entries.map((entry) => (
        <Box
          key={`${entry.kind}:${entry.key}`}
          id={envAnchor(entry.kind, entry.key)}
          className='mrx-docs-target'
          py='xs'
          px='xs'
          style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
        >
          <Group gap={6} wrap='wrap' mb={2}>
            <code className='mrx-code mrx-code-inline'>{entry.key}</code>
            {entry.owner && <OwnerBadge owner={entry.owner} />}
          </Group>
          {entry.description && (
            <Text size='sm'>
              <DescriptionText text={entry.description} />
            </Text>
          )}
          <Group gap='lg' wrap='wrap'>
            {showValue && entry.value !== undefined && (
              <Text size='sm' style={{ wordBreak: 'break-all' }}>
                <Text span c='dimmed' size='sm' mr={4}>Now:</Text>
                <Text span ff='monospace' size='sm'>{entry.value === '' ? 'empty' : entry.value}</Text>
              </Text>
            )}
            {entry.default && (
              <Text size='sm' style={{ wordBreak: 'break-all' }}>
                <Text span c='dimmed' size='sm' mr={4}>Default:</Text>
                <Text span ff='monospace' size='sm'>{entry.default}</Text>
              </Text>
            )}
          </Group>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The environment variables EiN and its modules read, by how they get there, with their values
 * in the reader's own shell. Settings are variables too, but they have their own page.
 */
export function EnvironmentReference() {
  const { data, loading, error } = useEnvReference();

  const byKind = useMemo(() => {
    const groups = new Map<Kind, EnvReference[]>();
    for (const entry of data ?? []) {
      const kind: Kind = entry.undescribed ? 'undescribed' : entry.kind;
      groups.set(kind, [...(groups.get(kind) ?? []), entry]);
    }
    for (const list of groups.values()) list.sort((a, b) => a.key.localeCompare(b.key));
    return groups;
  }, [data]);

  useScrollToHash(Boolean(data));

  return (
    <Box>
      <ReferenceIntro title='Environment'>
        What EiN reads from its environment, besides the{' '}
        <Anchor component={Link} to='/docs/settings'>settings</Anchor>, which are environment variables too. List your own shell's with:
      </ReferenceIntro>
      <HighlightedCode code={['env', 'docs env'].join('\n')} />

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} my='md'>
          {error.message}
        </Alert>
      )}
      {loading && !data && <PageLoader />}

      <Box mt='lg'>
        {SECTIONS.filter((section) => byKind.get(section.kind)?.length).map((section) => (
          <ReferenceSection key={section.kind} id={`env-${section.kind}`} title={section.title} intro={section.intro}>
            <EnvTable entries={byKind.get(section.kind)!} showValue={section.showValue} />
          </ReferenceSection>
        ))}
      </Box>
    </Box>
  );
}
