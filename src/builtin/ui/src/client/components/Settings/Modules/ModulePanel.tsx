import { Alert, Anchor, Badge, Box, Button, Group, Loader, Stack, Table, Tabs, Text } from '@mantine/core';
import { IconAlertTriangle, IconBook2, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCS_MODULES_PATH } from '@ein/paths';
import type { ModuleEntry, ModuleInstallResult, NodeTypeReference, ServiceEntry } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useConfig } from '../../../hooks/useConfig.ts';
import { useDocs } from '../../../hooks/useDocs.ts';
import { useCommandReference, useNodeTypeReference } from '../../../hooks/useReference.ts';
import { usePolledCommand } from '../../../hooks/useSystem.ts';
import { formatCount, formatUptime } from '../../../lib/format.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { DocView } from '../../Docs/DocView.tsx';
import { moduleRoute } from '../../Docs/reference.tsx';
import { SERVICE_STATUS_COLOR } from '../../System/ServicesHealth.tsx';
import { Done, Note, PanelHeader, PanelSection, useInlineConfirm } from '../Accounts/PanelParts.tsx';
import { ModuleCommands } from './ModuleCommands.tsx';
import { ModuleAvatar, moduleState, STATE_COLOR, STATE_LABEL } from './ModuleList.tsx';
import { ModuleSettings } from './ModuleSettings.tsx';

/** The panel's tabs, in order. */
const MODULE_SECTIONS = ['about', 'dependencies', 'services', 'pages', 'commands', 'settings', 'types'] as const;
type ModuleSection = typeof MODULE_SECTIONS[number];

const SECTION_LABEL: Record<ModuleSection, string> = {
  about: 'About',
  dependencies: 'Dependencies',
  services: 'Services',
  pages: 'Pages',
  commands: 'Commands',
  settings: 'Settings',
  types: 'Node types',
};

type ModulePanelProps = {
  module: ModuleEntry;
  /** Every installed module, for what it needs and what needs it. */
  modules: ModuleEntry[];
  onOpenModule: (name: string) => void;
  /** The tab asked for; one this module has nothing for shows About. */
  section: string | null;
  onSection: (section: string) => void;
  /** After it was updated, so the list is asked again. */
  onChanged: () => void;
  /** After it was removed. */
  onRemoved: () => void;
};

/**
 * One installed module: its name, version, where it is installed, when it was set up and its state,
 * why its setup failed, which repository and commit `mod install` fetched it from, with Update and
 * Remove for the administrator, and a link to its full reference; under that a tab each for the guide's introduction, what it needs and what needs it,
 * and what it brings — services with their state now, pages, commands, settings and node types.
 * A tab is drawn only when the module has something for it, with how many. Commands and settings
 * open in place, a command to its help and a setting to its control.
 */
export function ModulePanel({ module, modules, onOpenModule, section, onSection, onChanged, onRemoved }: ModulePanelProps) {
  const state = moduleState(module);
  const admin = useAccessIds()?.admin === true;
  const { data: commands, loading: commandsLoading } = useCommandReference();
  const config = useConfig();
  const { data: types } = useNodeTypeReference();

  const ownSettings = config.entries.filter((entry) => entry.owner === module.name);
  const ownTypes = (types ?? []).filter((entry) => entry.owner === module.name);
  const usedBy = modules.filter((entry) => Object.hasOwn(entry.dependencies, module.name));

  // What each tab counts; About counts nothing, and it and Dependencies are drawn regardless.
  const counts: Record<ModuleSection, number> = {
    about: 0,
    dependencies: Object.keys(module.dependencies).length + usedBy.length,
    services: module.services.length,
    pages: module.routes.length,
    commands: commands ? commands.filter((entry) => entry.module === module.name).length : module.commands.length,
    settings: ownSettings.length,
    types: ownTypes.length,
  };
  const shown = MODULE_SECTIONS.filter((each) => each === 'about' || each === 'dependencies' || counts[each] > 0);
  const current: ModuleSection = shown.find((each) => each === section) ?? 'about';

  return (
    <Stack gap='lg'>
      <PanelHeader
        avatar={<ModuleAvatar size={64} />}
        title={module.name}
        meta={[
          [module.version && `version ${module.version}`, module.coreApi && `core API ${module.coreApi}`].filter(Boolean).join(' · '),
          module.path,
          module.setup ? `set up ${new Date(module.setup.at).toLocaleString()}` : 'not set up since EiN started',
        ].filter(Boolean)}
        badges={<Badge size='sm' variant='light' color={STATE_COLOR[state]} tt='none'>{STATE_LABEL[state]}</Badge>}
      />
      {module.description && <Text size='sm'>{module.description}</Text>}
      {state === 'failed' && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='Its setup failed'>
          <Stack gap={4}>
            {module.setup!.problems.map((problem) => <Text key={problem} size='sm' ff='monospace' style={{ overflowWrap: 'anywhere' }}>{problem}</Text>)}
          </Stack>
        </Alert>
      )}
      {state === 'not set up' && (
        <Note warn>
          Installed, but not set up since EiN started: its commands are not on PATH and its services are not running.{' '}
          <Text span ff='monospace' size='sm'>mod setup {module.name}</Text> sets it up.
        </Note>
      )}
      {module.installed && <Installed module={module} usedBy={usedBy} admin={admin} onChanged={onChanged} onRemoved={onRemoved} />}
      <Box>
        <Button component={Link} to={moduleRoute(module.name)} variant='default' size='xs' leftSection={<IconBook2 size={16} />}>Reference and guide</Button>
      </Box>

      <Tabs value={current} onChange={(next) => next && onSection(next)} keepMounted={false}>
        <Tabs.List mb='md'>
          {shown.map((each) => (
            <Tabs.Tab
              key={each}
              value={each}
              rightSection={counts[each] > 0 ? <Badge size='xs' variant='light' color='gray' tt='none'>{counts[each]}</Badge> : undefined}
            >
              {SECTION_LABEL[each]}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel value='about'>
          <About module={module} />
        </Tabs.Panel>
        <Tabs.Panel value='dependencies'>
          <Dependencies module={module} modules={modules} usedBy={usedBy} onOpenModule={onOpenModule} />
        </Tabs.Panel>
        <Tabs.Panel value='services'>
          <Services module={module} />
        </Tabs.Panel>
        <Tabs.Panel value='pages'>
          <Pages module={module} />
        </Tabs.Panel>
        <Tabs.Panel value='commands'>
          {commands
            ? <ModuleCommands commands={commands} module={module.name} />
            : commandsLoading
            ? <Loader size='sm' />
            : <Text size='sm' ff='monospace'>{module.commands.join(' ')}</Text>}
        </Tabs.Panel>
        <Tabs.Panel value='settings'>
          <ModuleSettings entries={ownSettings} save={config.save} reset={config.reset} admin={admin} />
        </Tabs.Panel>
        <Tabs.Panel value='types'>
          <NodeTypes types={ownTypes} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

type InstalledProps = { module: ModuleEntry; usedBy: ModuleEntry[]; admin: boolean; onChanged: () => void; onRemoved: () => void };

/**
 * Where `mod install` fetched the module from, and for the administrator, Update — the newest
 * commit of the branch it was installed from, or the tag's commit again; one installed at a commit
 * stays there and has none — and Remove, which asks first and says what goes with it.
 */
function Installed({ module, usedBy, admin, onChanged, onRemoved }: InstalledProps) {
  const record = module.installed!;
  const pinned = record.ref === record.commit;
  const [busy, setBusy] = useState<'update' | 'remove' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const confirm = useInlineConfirm();

  const update = async () => {
    setBusy('update');
    setProblem(null);
    setDone(null);
    try {
      const result = await execCommand<ModuleInstallResult>(`mod install ${shq(`${record.repository}@${record.ref}`)}`);
      setDone(result.installed.some((each) => each.name === module.name) ? 'Updated' : 'Up to date');
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setProblem(null);
    try {
      await execCommand(`mod remove --force ${shq(module.name)}`);
      onRemoved();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <PanelSection
      title='Installed from its repository'
      lead={
        <>
          <Anchor href={record.repository} target='_blank' rel='noreferrer' size='sm' style={{ overflowWrap: 'anywhere' }}>{record.repository}</Anchor> at{' '}
          <Text span ff='monospace' size='sm'>{record.commit.slice(0, 9)}</Text>
          {!pinned && ` (${record.ref})`}
          {record.at && `, ${new Date(record.at).toLocaleString()}`}
        </>
      }
      error={problem}
      onDismiss={() => setProblem(null)}
    >
      {admin && !confirm.open && (
        <Group gap='xs'>
          {!pinned && (
            <Button size='xs' variant='default' leftSection={<IconRefresh size={16} />} loading={busy === 'update'} disabled={busy !== null} onClick={update}>
              Update
            </Button>
          )}
          <Button ref={confirm.opener} size='xs' variant='light' color='red' leftSection={<IconTrash size={16} />} disabled={busy !== null} onClick={confirm.show}>
            Remove
          </Button>
          {done && <Done>{done}</Done>}
        </Group>
      )}
      {admin && confirm.open && (
        <Stack gap='xs'>
          <Text size='sm'>
            Removing {module.name} stops its services and takes its commands, pages and files away. What it made in the archive stays.
            {usedBy.length > 0 && ` ${usedBy.map((entry) => entry.name).join(', ')} ${usedBy.length > 1 ? 'need' : 'needs'} it and will not work without it.`}
          </Text>
          <Group gap='xs'>
            <Button size='xs' color='red' loading={busy === 'remove'} onClick={remove} data-autofocus>Remove {module.name}</Button>
            <Button size='xs' variant='default' disabled={busy === 'remove'} onClick={confirm.cancel}>Cancel</Button>
          </Group>
        </Stack>
      )}
    </PanelSection>
  );
}

/** A table of a few columns that scrolls sideways rather than squeezing them on a phone. */
function SectionTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Table.ScrollContainer minWidth={440}>
      <Table verticalSpacing='xs' highlightOnHover className='mrx-module-table'>
        <Table.Thead>
          <Table.Tr>
            {head.map((label) => <Table.Th key={label}>{label}</Table.Th>)}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{children}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** The introduction from the module's guide (`/usr/docs/modules/<name>/index.md`), when it has one. */
function About({ module }: { module: ModuleEntry }) {
  const { tree, loading } = useDocs(DOCS_MODULES_PATH);
  const index = tree.find((node) => node.name === module.name)?.children?.find((node) => node.name.toLowerCase() === 'index.md');
  if (loading) return <Loader size='sm' />;
  return index ? <DocView path={index.path} /> : <Text size='sm' c='dimmed'>It has no guide.</Text>;
}

type DependenciesProps = { module: ModuleEntry; modules: ModuleEntry[]; usedBy: ModuleEntry[]; onOpenModule: (name: string) => void };

/** The modules it needs, with the versions it accepts, and the modules that need it; each opens in the panel. */
function Dependencies({ module, modules, usedBy, onOpenModule }: DependenciesProps) {
  const installed = new Map(modules.map((entry) => [entry.name, entry]));
  const rows = [
    ...Object.entries(module.dependencies).map(([name, range]) => ({ name, relation: 'It needs', range, entry: installed.get(name) })),
    ...usedBy.map((entry) => ({ name: entry.name, relation: 'Needs it', range: entry.dependencies[module.name], entry })),
  ];
  if (rows.length === 0) return <Text size='sm' c='dimmed'>It needs core only, and no module needs it.</Text>;

  return (
    <SectionTable head={['Module', 'Relation', 'Accepts', 'Installed', 'State']}>
      {rows.map(({ name, relation, range, entry }) => (
        <Table.Tr key={`${relation}:${name}`}>
          <Table.Td>
            {entry ? <Anchor component='button' type='button' size='sm' fw={500} onClick={() => onOpenModule(name)}>{name}</Anchor> : <Text size='sm' fw={500}>{name}</Text>}
          </Table.Td>
          <Table.Td>
            <Text size='sm' c='dimmed'>{relation}</Text>
          </Table.Td>
          <Table.Td>
            <Text size='sm' ff='monospace'>{range}</Text>
          </Table.Td>
          <Table.Td>
            <Text size='sm' ff='monospace'>{entry?.version ?? '—'}</Text>
          </Table.Td>
          <Table.Td style={{ whiteSpace: 'nowrap' }}>
            {entry
              ? <Badge size='sm' variant='light' color={STATE_COLOR[moduleState(entry)]} tt='none'>{STATE_LABEL[moduleState(entry)]}</Badge>
              : <Badge size='sm' variant='light' color='red' tt='none'>Not installed</Badge>}
          </Table.Td>
        </Table.Tr>
      ))}
    </SectionTable>
  );
}

/** Its services as `service-list` has them now, polled while the tab is open; the system page has their controls. */
function Services({ module }: { module: ModuleEntry }) {
  const { data, error } = usePolledCommand<ServiceEntry[]>('service-list');
  const byName = new Map((data ?? []).map((service) => [service.name, service]));

  return (
    <Stack gap='sm'>
      <Text size='sm' c='dimmed'>
        Started and stopped on the <Anchor component={Link} to='/system?tab=services' size='sm'>system page</Anchor>.
      </Text>
      {error && <Alert color='red' variant='light' p='xs' icon={<IconAlertTriangle size={16} />}>{error.message}</Alert>}
      <SectionTable head={['Service', 'State', 'Up for', 'What it does']}>
        {module.services.map((name) => {
          const service = byName.get(name);
          return (
            <Table.Tr key={name}>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>
                <Text size='sm' ff='monospace'>{name}</Text>
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>
                {service
                  ? (
                    <Badge size='sm' variant='light' color={service.enabled ? SERVICE_STATUS_COLOR[service.status] ?? 'gray' : 'gray'} tt='none'>
                      {service.enabled ? service.status : 'disabled'}
                    </Badge>
                  )
                  : data
                  ? <Badge size='sm' variant='light' color='gray' tt='none'>not registered</Badge>
                  : <Loader size='xs' />}
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>
                <Text size='sm' c='dimmed'>{service?.startedAt ? formatUptime(Date.now() - service.startedAt) : '—'}</Text>
              </Table.Td>
              <Table.Td>
                <Text size='sm' c='dimmed'>{service?.description}</Text>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </SectionTable>
    </Stack>
  );
}

/** Its routes; one without a parameter is a link to the page. */
function Pages({ module }: { module: ModuleEntry }) {
  return (
    <SectionTable head={['Route', 'Takes']}>
      {module.routes.map((path) => {
        const params = path.split('/').filter((part) => part.startsWith(':')).map((part) => part.slice(1));
        return (
          <Table.Tr key={path}>
            <Table.Td>
              {params.length > 0 ? <Text size='sm' ff='monospace'>{path}</Text> : <Anchor component={Link} to={path} size='sm' ff='monospace'>{path}</Anchor>}
            </Table.Td>
            <Table.Td>
              <Text size='sm' c='dimmed'>{params.length > 0 ? params.join(', ') : '—'}</Text>
            </Table.Td>
          </Table.Tr>
        );
      })}
    </SectionTable>
  );
}

/** The node types it defines, with how many of each exist. */
function NodeTypes({ types }: { types: NodeTypeReference[] }) {
  return (
    <SectionTable head={['Type', 'Category', 'Nodes', 'What it is']}>
      {types.map((entry) => (
        <Table.Tr key={entry.type}>
          <Table.Td>
            <Text size='sm' fw={500}>{entry.label ?? entry.type}</Text>
            {entry.label && <Text size='xs' c='dimmed' ff='monospace'>{entry.type}</Text>}
          </Table.Td>
          <Table.Td>
            <Text size='sm' c='dimmed'>{entry.category ?? '—'}</Text>
          </Table.Td>
          <Table.Td ta='right'>
            <Text size='sm'>{formatCount(entry.count)}</Text>
          </Table.Td>
          <Table.Td>
            <Text size='sm' c='dimmed'>{entry.description}</Text>
          </Table.Td>
        </Table.Tr>
      ))}
    </SectionTable>
  );
}
