import { Alert, Anchor, Badge, Box, Button, Group, Loader, Paper, Spoiler, Stack, Table, Tabs, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconBook2, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { Link } from 'react-router-dom';
import { tryParse } from '@std/semver';
import type { ModuleEntry, ModuleInstallJob, NodeTypeReference, ServiceEntry } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useConfig } from '../../../hooks/useConfig.ts';
import { useGuide } from '../../../hooks/useGuide.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { useCommandReference, useNodeTypeReference } from '../../../hooks/useReference.ts';
import { usePolledCommand } from '../../../hooks/useSystem.ts';
import { formatCount, formatUptime } from '../../../lib/format.ts';
import { formatGroupList, parseGroupList } from '../../../lib/accounts.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { modulePages } from '../../../lib/guide.ts';
import { GuidePageList } from '../../Docs/ModuleReference.tsx';
import { moduleRoute } from '../../Docs/reference.tsx';
import { SERVICE_STATUS_COLOR } from '../../System/ServicesHealth.tsx';
import { GroupsMultiSelect } from '../AccountInputs.tsx';
import { Done, Note, useInlineConfirm } from '../Accounts/PanelParts.tsx';
import { ModuleCommands } from './ModuleCommands.tsx';
import { ModuleAvatar, moduleState, STATE_COLOR, STATE_LABEL } from './ModuleList.tsx';
import { ModuleSettings } from './ModuleSettings.tsx';
import { formatDateTime } from '../../../lib/datetime.ts';
import { panelRoute, panelsOf } from '../../../signals/nav.ts';
import { TablerIcon } from '../../Icon/TablerIcon.tsx';
import { RoutePanel } from '../../Surface/SurfaceRouter.tsx';

/** The panel's tabs, in order. */
const MODULE_SECTIONS = ['overview', 'dependencies', 'services', 'pages', 'commands', 'settings', 'types'] as const;
type ModuleSection = typeof MODULE_SECTIONS[number];

const SECTION_LABEL: Record<ModuleSection, string> = {
  overview: 'Overview',
  dependencies: 'Dependencies',
  services: 'Services',
  pages: 'Pages',
  commands: 'Commands',
  settings: 'Settings',
  types: 'Node types',
};

/** `https://github.com/einhq/module-archive` → `github.com/einhq/module-archive`. */
const withoutScheme = (url: string): string => url.replace(/^[a-z]+:\/\//i, '');

type ModulePanelProps = {
  module: ModuleEntry;
  /** Every installed module, for what it needs and what needs it. */
  modules: ModuleEntry[];
  onOpenModule: (name: string) => void;
  /** The tab asked for; one this module has nothing for shows Overview. */
  section: string | null;
  onSection: (section: string) => void;
  /** After it changed here, so the list is asked again. */
  onChanged: () => void;
  /** The install EiN is running, or the last one: while one runs, Update waits. */
  install: ModuleInstallJob | null;
  /** After an update was started, so how it stands is asked at once. */
  onStarted: () => void;
  /** After it was removed. */
  onRemoved: () => void;
};

/**
 * One installed module. At the top what it is — its name, version, state and description, a long
 * one cut to three lines that More opens — with Update and Remove for the administrator and a link
 * to its documentation, then why its setup failed, when it did. Under that a tab each: Overview, with who has it, where it came from and
 * when, and the guide's pages on it; what it needs and what needs it; and what it brings —
 * services with their state now, pages, commands, settings and node types. A tab is drawn only
 * when the module has something for it, with how many. Commands and settings open in place, a
 * command to its help and a setting to its control; the module's settings views come before its
 * settings.
 */
export function ModulePanel({ module, modules, onOpenModule, section, onSection, onChanged, install, onStarted, onRemoved }: ModulePanelProps) {
  useSignals();
  const state = moduleState(module);
  const admin = useAccessIds()?.admin === true;
  const phone = usePhone();
  const { data: commands, loading: commandsLoading } = useCommandReference();
  const config = useConfig();
  const { data: types } = useNodeTypeReference();

  const ownSettings = config.entries.filter((entry) => entry.owner === module.name);
  // Its settings views, drawn before the list of its settings as on the System tab.
  const ownViews = panelsOf('settings.views').filter((view) => view.source === module.name);
  const ownTypes = (types ?? []).filter((entry) => entry.owner === module.name);
  const usedBy = modules.filter((entry) => Object.hasOwn(entry.dependencies, module.name));

  // What each tab counts; Overview counts nothing, and it and Dependencies are drawn regardless.
  const counts: Record<ModuleSection, number> = {
    overview: 0,
    dependencies: Object.keys(module.dependencies).length + usedBy.length,
    services: module.services.length,
    pages: module.routes.length,
    commands: commands ? commands.filter((entry) => entry.module === module.name).length : module.commands.length,
    settings: ownSettings.length,
    types: ownTypes.length,
  };
  const shown = MODULE_SECTIONS.filter((each) => each === 'overview' || each === 'dependencies' || counts[each] > 0);
  const current: ModuleSection = shown.find((each) => each === section) ?? 'overview';

  return (
    <Stack gap='lg'>
      <Stack gap='md'>
        <Group gap='md' wrap='nowrap' align='flex-start'>
          <ModuleAvatar size={phone ? 48 : 56} />
          <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
            <Group gap='xs' align='baseline' wrap='wrap' style={{ rowGap: 2 }}>
              <Title order={3} style={{ overflowWrap: 'anywhere' }}>{module.name}</Title>
              {module.version && <Text size='sm' c='dimmed' ff='monospace'>{module.version}</Text>}
              <Badge size='sm' variant='light' color={STATE_COLOR[state]} tt='none' style={{ alignSelf: 'center' }}>{STATE_LABEL[state]}</Badge>
            </Group>
            {module.description && (
              <Spoiler maxHeight={62} showLabel='More' hideLabel='Less' styles={{ control: { fontSize: 'var(--mantine-font-size-sm)' } }}>
                <Text size='sm'>{module.description}</Text>
              </Spoiler>
            )}
          </Stack>
        </Group>
        <Actions module={module} usedBy={usedBy} admin={admin} install={install} onStarted={onStarted} onRemoved={onRemoved} />
      </Stack>

      {state === 'failed' && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='Its setup failed'>
          <Stack gap={4}>
            {module.setup!.problems.map((problem) => <Text key={problem} size='sm' ff='monospace' style={{ overflowWrap: 'anywhere' }}>{problem}</Text>)}
          </Stack>
        </Alert>
      )}
      {state === 'not set up' && (
        <Alert color='yellow' variant='light' icon={<IconAlertTriangle size={16} />} title='Not set up since EiN started'>
          <Text size='sm'>
            Its commands are not on PATH and its services are not running. <Text span ff='monospace' size='sm'>mod setup {module.name}</Text> sets it up.
          </Text>
        </Alert>
      )}

      <Tabs value={current} onChange={(next) => next && onSection(next)} keepMounted={false} className='mrx-module-tabs' data-phone={phone || undefined}>
        <Tabs.List mb='md'>
          {shown.map((each) => (
            <Tabs.Tab
              key={each}
              value={each}
              rightSection={counts[each] > 0 ? <Text span size='xs' c='dimmed'>{counts[each]}</Text> : undefined}
            >
              {SECTION_LABEL[each]}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel value='overview'>
          <Overview module={module} usedBy={usedBy} admin={admin} onChanged={onChanged} />
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
          <Stack gap='lg'>
            {ownViews.map((view) => (
              <Paper key={view.id} p='md' radius='md' withBorder>
                <Stack gap='sm'>
                  <Group gap='xs' wrap='nowrap'>
                    <TablerIcon name={view.icon ?? 'adjustments'} size={18} />
                    <Title order={5}>{view.label}</Title>
                  </Group>
                  {view.description && <Text size='sm' c='dimmed'>{view.description}</Text>}
                  <RoutePanel path={panelRoute(view)} />
                </Stack>
              </Paper>
            ))}
            <ModuleSettings entries={ownSettings} save={config.save} reset={config.reset} admin={admin} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value='types'>
          <NodeTypes types={ownTypes} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

type ActionsProps = {
  module: ModuleEntry;
  usedBy: ModuleEntry[];
  admin: boolean;
  install: ModuleInstallJob | null;
  onStarted: () => void;
  onRemoved: () => void;
};

/**
 * What can be done with the module: for the administrator, on one `mod install` fetched, Update —
 * the newest release when it was installed at one, the newest commit of the branch it was installed
 * from, or another tag's commit again; one installed at a commit stays there and has none — and
 * Remove, which asks first, in place of the buttons, and says what goes with it; for everyone its
 * documentation. An update runs on its own, which the tab follows, and waits while another install
 * runs.
 */
function Actions({ module, usedBy, admin, install, onStarted, onRemoved }: ActionsProps) {
  const record = admin ? module.installed : undefined;
  const pinned = record !== undefined && record.ref === record.commit;
  // A release, `v<version>`, is updated to the newest release this core can run, which `mod install` takes without a ref.
  const version = record?.ref.startsWith('v') ? tryParse(record.ref.slice(1)) : undefined;
  const release = version !== undefined && !version.prerelease?.length;
  const [busy, setBusy] = useState<'update' | 'remove' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const confirm = useInlineConfirm();
  const target = record && (release ? record.repository : `${record.repository}@${record.ref}`);
  const running = install?.state === 'running' ? install : null;

  const update = async () => {
    setBusy('update');
    setProblem(null);
    try {
      await execCommand(`mod install --background ${shq(target!)}`);
      onStarted();
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
    <Stack gap='xs'>
      {confirm.open ? <RemoveConfirm module={module} usedBy={usedBy} busy={busy === 'remove'} onRemove={remove} onCancel={confirm.cancel} /> : (
        <Group gap='xs'>
          {record && !pinned && (
            <Button
              size='xs'
              variant='default'
              leftSection={<IconRefresh size={16} />}
              loading={busy === 'update' || running?.args.includes(target!) === true}
              disabled={busy !== null || running !== null}
              onClick={update}
            >
              Update
            </Button>
          )}
          {record && (
            <Button ref={confirm.opener} size='xs' variant='light' color='red' leftSection={<IconTrash size={16} />} disabled={busy !== null} onClick={confirm.show}>
              Remove
            </Button>
          )}
          <Button component={Link} to={moduleRoute(module.name)} size='xs' variant='default' leftSection={<IconBook2 size={16} />}>Documentation</Button>
        </Group>
      )}
      {problem && (
        <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setProblem(null)}>
          <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
        </Alert>
      )}
    </Stack>
  );
}

type RemoveConfirmProps = { module: ModuleEntry; usedBy: ModuleEntry[]; busy: boolean; onRemove: () => void; onCancel: () => void };

/** Remove spelled out where it was asked for: what goes with the module, and what stops working without it. It takes the focus as it opens. */
function RemoveConfirm({ module, usedBy, busy, onRemove, onCancel }: RemoveConfirmProps) {
  const textId = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);

  return (
    <Paper
      role='group'
      aria-labelledby={textId}
      p='md'
      radius='md'
      withBorder
      bg='color-mix(in srgb, var(--mantine-color-red-filled) 7%, var(--mrx-surface-raised))'
      style={{ borderColor: 'color-mix(in srgb, var(--mantine-color-red-filled) 55%, transparent)' }}
    >
      <Stack gap='sm'>
        <Text id={textId} size='sm'>
          Removing {module.name} stops its services and takes its commands, pages and files away. What it made in the archive stays.
          {usedBy.length > 0 && ` ${usedBy.map((entry) => entry.name).join(', ')} ${usedBy.length > 1 ? 'need' : 'needs'} it and will not work without it.`}
        </Text>
        <Group gap='xs'>
          <Button ref={button} size='xs' color='red' leftSection={<IconTrash size={16} />} loading={busy} onClick={onRemove}>Remove {module.name}</Button>
          <Button size='xs' variant='default' disabled={busy} onClick={onCancel}>Cancel</Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** One line of the overview's details: what it is, and its value beside it, or under it where the panel is narrow. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

type OverviewProps = { module: ModuleEntry; usedBy: ModuleEntry[]; admin: boolean; onChanged: () => void };

/**
 * The module at a glance: who has it, its version and the module API it is written against, where
 * `mod install` fetched it from and when — or that the deployment provides it — when it was set up
 * and the folder it is in; beside that, or under it where the panel is narrow, the guide's pages on it.
 */
function Overview({ module, usedBy, admin, onChanged }: OverviewProps) {
  const record = module.installed;
  return (
    <div className='mrx-module-overview'>
      <Box>
        <Title order={5} mb='xs'>Details</Title>
        <dl className='mrx-module-facts'>
          <Fact label='Available to'>
            <AvailableTo module={module} usedBy={usedBy} admin={admin} onChanged={onChanged} />
          </Fact>
          <Fact label='Version'>
            <Text span size='sm' ff='monospace'>{module.version ?? '—'}</Text>
          </Fact>
          {module.coreApi && (
            <Fact label='Core API'>
              <Text span size='sm' ff='monospace'>{module.coreApi}</Text>
            </Fact>
          )}
          <Fact label='Source'>
            {record
              ? <Anchor href={record.repository} target='_blank' rel='noreferrer' size='sm' title={record.repository}>{withoutScheme(record.repository)}</Anchor>
              : 'Comes with the deployment'}
          </Fact>
          {record && (
            <Fact label='Installed'>
              <Text span size='sm' ff='monospace'>{record.ref === record.commit ? record.commit.slice(0, 9) : `${record.ref} · ${record.commit.slice(0, 9)}`}</Text>
              {record.at && <Text size='xs' c='dimmed'>{formatDateTime(record.at)}</Text>}
            </Fact>
          )}
          <Fact label='Set up'>{module.setup ? formatDateTime(module.setup.at) : 'Not since EiN started'}</Fact>
          <Fact label='Folder'>
            <Text span size='sm' ff='monospace'>{module.path}</Text>
          </Fact>
        </dl>
      </Box>
      <Box>
        <Title order={5} mb='xs'>In the guide</Title>
        <About module={module} />
      </Box>
    </div>
  );
}

type AvailableToProps = { module: ModuleEntry; usedBy: ModuleEntry[]; admin: boolean; onChanged: () => void };

/**
 * Who the module is for: everyone, or the groups it is kept to (`mod groups`), whose members alone
 * have its commands, its entries in the navigation and its pages; administrators have every
 * module. The administrator's Change opens the groups in place, none for everyone.
 */
function AvailableTo({ module, usedBy, admin, onChanged }: AvailableToProps) {
  const saved = formatGroupList(module.groups ?? []);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const groups = parseGroupList(value);
  // What needs it and is everyone's calls it for people it would be refused to.
  const exposed = groups.length > 0 ? usedBy.filter((entry) => !entry.groups?.length) : [];

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await execCommand(`mod groups ${shq(module.name)} ${groups.length > 0 ? groups.map(shq).join(' ') : '--everyone'}`);
      setDone(true);
      setEditing(false);
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <Group gap='xs' wrap='wrap' style={{ rowGap: 2 }}>
        <Text span size='sm'>{module.groups?.length ? `${module.groups.join(', ')} and administrators` : 'Everyone'}</Text>
        {admin && (
          <Anchor
            component='button'
            type='button'
            size='sm'
            onClick={() => {
              setValue(saved);
              setDone(false);
              setEditing(true);
            }}
          >
            Change
          </Anchor>
        )}
        {done && <Done>Saved</Done>}
      </Group>
    );
  }

  return (
    <Stack gap='xs'>
      <Text size='xs' c='dimmed'>Only members of the groups chosen, and administrators, get its commands, its entries in the navigation and its pages. None is everyone.</Text>
      <GroupsMultiSelect homeable value={value} onChange={setValue} placeholder='Everyone' aria-label='Groups it is kept to' disabled={busy} />
      {exposed.length > 0 && (
        <Note warn>
          {exposed.map((entry) => entry.name).join(', ')} {exposed.length > 1 ? 'need' : 'needs'} {module.name} and {exposed.length > 1 ? 'are' : 'is'} everyone's: what{' '}
          {exposed.length > 1 ? 'they run' : 'it runs'} of {module.name} fails for anyone outside these groups.
        </Note>
      )}
      <Group gap='xs'>
        <Button size='xs' loading={busy} disabled={value === saved} onClick={save}>Save</Button>
        <Button size='xs' variant='default' disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
      </Group>
      {problem && (
        <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setProblem(null)}>
          {problem}
        </Alert>
      )}
    </Stack>
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

/** The guide's section on the module (its pages under `<name>/`), when the guide has one. */
function About({ module }: { module: ModuleEntry }) {
  const { guide, loading } = useGuide();
  const pages = modulePages(guide, module.name);
  if (loading) return <Loader size='sm' />;
  return pages.length ? <GuidePageList pages={pages} /> : <Text size='sm' c='dimmed'>The guide has no section on it.</Text>;
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
