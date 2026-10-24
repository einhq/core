import { Alert, Anchor, Badge, Box, Card, Group, List, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconAlertTriangle } from '@tabler/icons-react';
import { DOCS_MODULES_PATH } from '@ein/paths';
import { type ReactNode, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { type DocNode, useCommandReference, useConfig, useDocs, useEnvReference, useModuleReference, useNodeTypeReference } from '@ein/ui/hooks';
import { displayNames, EffectBadge } from './CommandReference.tsx';
import { DocView } from './DocView.tsx';
import { commandRoute, docRoute, envAnchor, moduleRoute, nodeTypeAnchor, ReferenceIntro, ReferenceSection, settingAnchor } from './reference.tsx';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Every installed module, with what each brings. */
export function ModulesReference() {
  const { data: modules, loading, error } = useModuleReference();
  const { data: commands } = useCommandReference();
  const { entries: settings } = useConfig();
  const { data: types } = useNodeTypeReference();

  return (
    <Box>
      <ReferenceIntro title='Modules'>
        EiN is a small core and the modules installed on it. Photos and video, people, locations, the assistant — each is a module, and each brings its own commands, settings
        and node types. These are the ones installed here.
      </ReferenceIntro>

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} my='md'>
          {error.message}
        </Alert>
      )}
      {loading && !modules && <PageLoader />}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing='sm'>
        {(modules ?? []).map((module) => {
          const brings = [
            commands && count(commands.filter((entry) => entry.module === module.name).length, 'command'),
            count(settings.filter((entry) => entry.owner === module.name).length, 'setting'),
            types && count(types.filter((entry) => entry.owner === module.name).length, 'node type'),
          ].filter(Boolean);
          return (
            <Card key={module.name} component={Link} to={moduleRoute(module.name)} radius='md' padding='md'>
              <Group gap='xs' mb={4}>
                <Title order={3} fz='md'>{module.name}</Title>
                {module.version && <Text size='xs' c='dimmed'>{module.version}</Text>}
              </Group>
              {module.description && <Text size='sm' mb='xs'>{module.description}</Text>}
              <Text size='xs' c='dimmed'>{brings.join(' · ')}</Text>
            </Card>
          );
        })}
      </SimpleGrid>
    </Box>
  );
}

/** A module's own markdown, under `/usr/docs/modules/<name>`: its index inline, the rest as links. */
function ModuleDocs({ name }: { name: string }) {
  const { tree, loading } = useDocs(DOCS_MODULES_PATH);
  const root = tree.find((node) => node.name === name);
  if (loading) return <Loader size='sm' />;
  if (!root) return null;

  const pages: DocNode[] = [];
  const walk = (nodes: DocNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === 'directory') walk(node.children);
      else if (node.path !== `${root.path}/index.md`) pages.push(node);
    }
  };
  walk(root.children);
  const hasIndex = root.children?.some((node) => node.name.toLowerCase() === 'index.md');

  return (
    <ReferenceSection id='guide' title='Guide'>
      {hasIndex && <DocView path={`${root.path}/index.md`} />}
      {pages.length > 0 && (
        <List spacing={4} mt='sm'>
          {pages.map((page) => (
            <List.Item key={page.path}>
              <Anchor component={Link} to={docRoute(page.path)}>{page.name.replace(/\.md$/i, '').replace(/[-_]/g, ' ')}</Anchor>
            </List.Item>
          ))}
        </List>
      )}
    </ReferenceSection>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <Stack gap={6}>{children}</Stack>;
}

/** One module: what it is, what it needs, and everything it brings, each linked to its full entry. */
export function ModuleDetail({ name }: { name: string }) {
  const { data: modules, loading, error } = useModuleReference();
  const { data: commands, loading: commandsLoading } = useCommandReference();
  const { entries: settings } = useConfig();
  const { data: env } = useEnvReference();
  const { data: types } = useNodeTypeReference();

  const module = modules?.find((entry) => entry.name === name);
  const names = useMemo(() => displayNames(commands ?? []), [commands]);
  const own = {
    commands: (commands ?? []).filter((entry) => entry.module === name).toSorted((a, b) => names.get(a.name)!.localeCompare(names.get(b.name)!)),
    settings: settings.filter((entry) => entry.owner === name),
    env: (env ?? []).filter((entry) => entry.owner === name),
    types: (types ?? []).filter((entry) => entry.owner === name),
  };
  const usedBy = (modules ?? []).filter((entry) => entry.dependencies[name]);

  if (loading && !modules) {
    return <PageLoader />;
  }
  if (error) return <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>{error.message}</Alert>;
  if (!module) return <Text c='dimmed'>No module called {name} is installed.</Text>;

  const dependencies = Object.keys(module.dependencies);

  return (
    <Box>
      <ReferenceIntro
        title={module.name}
        aside={
          <Group gap='lg' wrap='wrap'>
            {module.version && (
              <Text size='sm'>
                <Text span c='dimmed' size='sm' mr={4}>Version</Text>
                {module.version}
              </Text>
            )}
            <Text size='sm'>
              <Text span c='dimmed' size='sm' mr={4}>Needs</Text>
              {dependencies.length === 0 ? 'core only' : dependencies.map((dep, i) => {
                const target = dep.replace(/ \(optional\)$/, '');
                return (
                  <span key={dep}>
                    {i > 0 && ', '}
                    <Anchor component={Link} to={moduleRoute(target)} size='sm'>{dep}</Anchor>
                  </span>
                );
              })}
            </Text>
            {usedBy.length > 0 && (
              <Text size='sm'>
                <Text span c='dimmed' size='sm' mr={4}>Used by</Text>
                {usedBy.map((entry, i) => (
                  <span key={entry.name}>
                    {i > 0 && ', '}
                    <Anchor component={Link} to={moduleRoute(entry.name)} size='sm'>{entry.name}</Anchor>
                  </span>
                ))}
              </Text>
            )}
          </Group>
        }
      >
        {module.description ?? ''}
      </ReferenceIntro>

      <ModuleDocs name={name} />

      <ReferenceSection id='commands' title='Commands'>
        {commandsLoading && !commands ? <Loader size='sm' /> : own.commands.length === 0 ? <Text size='sm' c='dimmed'>None.</Text> : (
          <Rows>
            {own.commands.map((entry) => (
              <Group key={entry.name} gap='xs' wrap='nowrap' align='flex-start'>
                <Anchor component={Link} to={commandRoute(entry.name)} ff='monospace' size='sm' style={{ flexShrink: 0 }}>{names.get(entry.name)}</Anchor>
                <EffectBadge effect={entry.spec.effect} />
                <Text size='sm' c='dimmed' lineClamp={2}>{entry.spec.description}</Text>
              </Group>
            ))}
          </Rows>
        )}
      </ReferenceSection>

      {own.settings.length > 0 && (
        <ReferenceSection id='settings' title='Settings'>
          <Rows>
            {own.settings.map((entry) => (
              <Group key={entry.key} gap='xs' wrap='nowrap' align='flex-start'>
                <Anchor component={Link} to={`/docs/settings#${settingAnchor(entry.key)}`} size='sm' style={{ flexShrink: 0 }}>{entry.label}</Anchor>
                <Badge size='xs' radius='sm' variant='light' color={entry.scope === 'user' ? 'grape' : 'gray'} tt='none'>
                  {entry.scope === 'user' ? 'personal' : 'system'}
                </Badge>
                <Text size='sm' c='dimmed' lineClamp={2}>{entry.description}</Text>
              </Group>
            ))}
          </Rows>
        </ReferenceSection>
      )}

      {own.env.length > 0 && (
        <ReferenceSection id='environment' title='Environment'>
          <Rows>
            {own.env.map((entry) => (
              <Group key={entry.key} gap='xs' wrap='nowrap' align='flex-start'>
                <Anchor component={Link} to={`/docs/environment#${envAnchor(entry.kind, entry.key)}`} ff='monospace' size='sm' style={{ flexShrink: 0 }}>{entry.key}</Anchor>
                <Text size='sm' c='dimmed' lineClamp={2}>{entry.description}</Text>
              </Group>
            ))}
          </Rows>
        </ReferenceSection>
      )}

      {own.types.length > 0 && (
        <ReferenceSection id='node-types' title='Node types'>
          <Rows>
            {own.types.map((entry) => (
              <Group key={entry.type} gap='xs' wrap='nowrap' align='flex-start'>
                <Anchor component={Link} to={`/docs/node-types#${nodeTypeAnchor(entry.type)}`} size='sm' style={{ flexShrink: 0 }}>{entry.label ?? entry.type}</Anchor>
                <Text size='sm' c='dimmed' lineClamp={2}>{entry.description}</Text>
              </Group>
            ))}
          </Rows>
        </ReferenceSection>
      )}
    </Box>
  );
}
