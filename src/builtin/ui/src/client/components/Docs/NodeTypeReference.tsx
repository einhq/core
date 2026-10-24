import { Alert, Box, Card, Group, SimpleGrid, Text, Title } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { type NodeTypeReference as NodeTypeEntry, useNodeTypeReference } from '@ein/ui/hooks';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';
import { DescriptionText, nodeTypeAnchor, OwnerBadge, ReferenceIntro, ReferenceSection, useScrollToHash } from './reference.tsx';

const SECTIONS: { category: NodeTypeEntry['category'] | 'other'; title: string; intro: string }[] = [
  { category: 'content', title: 'What the archive holds', intro: 'The things people put in and look at.' },
  { category: 'structure', title: 'How it is arranged', intro: 'Folders, links, and who may see what.' },
  {
    category: 'system',
    title: 'How it runs',
    intro: 'What the system keeps for itself: commands, logs, queues, sessions. You meet them browsing /var, /dev and /usr in the shell.',
  },
  { category: 'other', title: 'Also in the tree', intro: 'Types that exist but that no installed module describes, perhaps left by one since removed.' },
];

function NodeTypeCard({ entry }: { entry: NodeTypeEntry }) {
  return (
    <Card id={nodeTypeAnchor(entry.type)} className='mrx-docs-target' radius='md' padding='md'>
      <Group justify='space-between' align='flex-start' gap='xs' mb={4} wrap='nowrap'>
        <Group gap='xs' wrap='wrap'>
          <Title order={3} fz='md'>{entry.label ?? entry.type}</Title>
          <HighlightedCode inline language='text' code={entry.type} />
        </Group>
        {entry.owner && <OwnerBadge owner={entry.owner} />}
      </Group>
      {entry.description && (
        <Text size='sm' mb='xs'>
          <DescriptionText text={entry.description} />
        </Text>
      )}
      <Text size='xs' c='dimmed'>
        {entry.count === 0 ? 'None yet' : `${entry.count.toLocaleString()} in the tree`}
      </Text>
    </Card>
  );
}

/**
 * Every node type — core's, each installed module's, and any in use that nobody describes — with
 * how many exist. The counts come from the database, so the page is as current as the tree.
 */
export function NodeTypeReference() {
  const { data, loading, error } = useNodeTypeReference();

  const byCategory = useMemo(() => {
    const groups = new Map<string, NodeTypeEntry[]>();
    for (const entry of data ?? []) {
      const key = entry.category ?? 'other';
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const list of groups.values()) list.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    return groups;
  }, [data]);

  useScrollToHash(Boolean(data));

  return (
    <Box>
      <ReferenceIntro title='Node types'>
        Everything in EiN is a node in one tree, like files and folders, and every node has a type that decides what it holds and how it behaves. Albums, people and locations
        come from modules, so this list follows what is installed. A node's type is in the shell too:
      </ReferenceIntro>
      <HighlightedCode code={['stat /archive/albums', 'ls -l /archive/people', 'docs node-types'].join('\n')} />

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} my='md'>
          {error.message}
        </Alert>
      )}
      {loading && !data && <PageLoader />}

      <Box mt='lg'>
        {SECTIONS.filter((section) => byCategory.get(section.category ?? 'other')?.length).map((section) => (
          <ReferenceSection key={section.category} id={`types-${section.category}`} title={section.title} intro={section.intro}>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing='sm'>
              {byCategory.get(section.category ?? 'other')!.map((entry) => <NodeTypeCard key={entry.type} entry={entry} />)}
            </SimpleGrid>
          </ReferenceSection>
        ))}
      </Box>
    </Box>
  );
}
