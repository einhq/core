import { Alert, Anchor, Badge, Box, Button, Group, Loader, Paper, Spoiler, Stack, Table, Tabs, Text, Title, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconBook2, IconCheck, IconChevronRight, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { Link } from 'react-router-dom';
import { tryParse } from '@std/semver';
import type { GroupEntry, ModuleEntry, ModuleInstallJob, NodeTypeReference, ServiceEntry } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useConfig } from '../../../hooks/useConfig.ts';
import { useIdentities } from '../../../hooks/useIdentities.ts';
import { usePhone } from '../../../hooks/usePhone.ts';
import { useCommandReference, useNodeTypeReference } from '../../../hooks/useReference.ts';
import { usePolledCommand } from '../../../hooks/useSystem.ts';
import { formatCount, formatUptime } from '../../../lib/format.ts';
import { displayName, sortGroups } from '../../../lib/accounts.ts';
import { formatDateTime } from '../../../lib/datetime.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { panelRoute, panelsOf } from '../../../signals/nav.ts';
import { moduleRoute } from '../../Docs/reference.tsx';
import { TablerIcon } from '../../Icon/TablerIcon.tsx';
import { GroupAvatar } from '../../Identity/GroupAvatar.tsx';
import { ModuleAvatar, moduleColor } from '../../Identity/ModuleAvatar.tsx';
import { Dialog, DialogActions } from '../../Surface/Dialog.tsx';
import { RoutePanel } from '../../Surface/SurfaceRouter.tsx';
import { SERVICE_STATUS_COLOR } from '../../System/ServicesHealth.tsx';
import { Checklist, type ChecklistItem } from '../Accounts/Checklist.tsx';
import { Note, PanelSection } from '../Accounts/PanelParts.tsx';
import { ModuleCommands } from './ModuleCommands.tsx';
import { moduleState, STATE_COLOR, STATE_LABEL } from './ModuleList.tsx';
import { ModuleSettings } from './ModuleSettings.tsx';
import type { ModuleUpdate } from './useModuleUpdates.ts';

/** The panel's tabs, in order. */
const MODULE_SECTIONS = ['overview', 'setup', 'services', 'pages', 'commands', 'settings', 'types'] as const;
type ModuleSection = typeof MODULE_SECTIONS[number];

const SECTION_LABEL: Record<ModuleSection, string> = {
  overview: 'Overview',
  setup: 'Set up',
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
  /** Whether there is something newer to update it to (`mod outdated`). */
  update: ModuleUpdate;
  /** After an update was started, so how it stands is asked at once. */
  onStarted: () => void;
  /** After it was removed. */
  onRemoved: () => void;
};

/**
 * One installed module. At the top, on a tile in the module's colour, what it is — its name, its
 * version and its state, and its description, a long one cut to three lines that More opens — with
 * its buttons at the top right: Update, which says what it updates to, and Remove for the
 * administrator, and its documentation for everyone; under the tile why its setup failed, when it
 * did. Under that a tab each: Overview, with who has it, what it needs and what needs it, and where
 * it came from; the module's settings views (Set up), as on the System tab, for the administrator;
 * and what it brings — services with their state now, pages, commands, settings and node types. A
 * tab is drawn only when the module has something for it, with how many. Commands and settings open
 * in place, a command to its help and a setting to its control.
 */
export function ModulePanel({ module, modules, onOpenModule, section, onSection, onChanged, install, update, onStarted, onRemoved }: ModulePanelProps) {
  useSignals();
  const state = moduleState(module);
  const admin = useAccessIds()?.admin === true;
  const phone = usePhone();
  const { data: commands, loading: commandsLoading } = useCommandReference();
  const config = useConfig();
  const { data: types } = useNodeTypeReference();
  const [problem, setProblem] = useState<string | null>(null);

  const ownSettings = config.entries.filter((entry) => entry.owner === module.name);
  // Its settings views, which set up one thing each, as the System tab has them.
  const ownViews = admin ? panelsOf('settings.views').filter((view) => view.source === module.name) : [];
  const ownTypes = (types ?? []).filter((entry) => entry.owner === module.name);
  const usedBy = modules.filter((entry) => Object.hasOwn(entry.dependencies, module.name));

  // What each tab counts; Overview counts nothing and is drawn regardless.
  const counts: Record<ModuleSection, number> = {
    overview: 0,
    setup: ownViews.length,
    services: module.services.length,
    pages: module.routes.length,
    commands: commands ? commands.filter((entry) => entry.module === module.name).length : module.commands.length,
    settings: ownSettings.length,
    types: ownTypes.length,
  };
  const shown = MODULE_SECTIONS.filter((each) => each === 'overview' || counts[each] > 0);
  const current: ModuleSection = shown.find((each) => each === section) ?? 'overview';

  return (
    <Stack gap='lg'>
      <Stack gap='sm' className='mrx-module-tile' style={{ '--mrx-module-color': moduleColor(module.name) } as CSSProperties}>
        <div className='mrx-module-head'>
          <Group gap='md' wrap='nowrap' align='center' className='mrx-module-head-name'>
            <ModuleAvatar name={module.name} size={phone ? 48 : 56} />
            <Stack gap={6} style={{ minWidth: 0 }}>
              <Title order={3} lh={1.15} style={{ overflowWrap: 'anywhere' }}>{module.name}</Title>
              <Group gap='xs' wrap='wrap' style={{ rowGap: 4 }}>
                {module.version && <Badge size='lg' radius='sm' variant='default' tt='none' ff='monospace' fw={600} title='Version'>{module.version}</Badge>}
                <Badge size='lg' radius='sm' variant='light' color={STATE_COLOR[state]} tt='none'>{STATE_LABEL[state]}</Badge>
              </Group>
            </Stack>
          </Group>
          <Actions module={module} usedBy={usedBy} admin={admin} install={install} update={update} onStarted={onStarted} onRemoved={onRemoved} onProblem={setProblem} />
        </div>
        {module.description && (
          <Spoiler maxHeight={62} showLabel='More' hideLabel='Less' styles={{ control: { fontSize: 'var(--mantine-font-size-sm)' } }}>
            <Text size='sm'>{module.description}</Text>
          </Spoiler>
        )}
        {problem && (
          <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setProblem(null)}>
            <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
          </Alert>
        )}
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
          <Overview module={module} modules={modules} usedBy={usedBy} admin={admin} onChanged={onChanged} onOpenModule={onOpenModule} />
        </Tabs.Panel>
        <Tabs.Panel value='setup'>
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
          </Stack>
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

type ActionsProps = {
  module: ModuleEntry;
  usedBy: ModuleEntry[];
  admin: boolean;
  install: ModuleInstallJob | null;
  update: ModuleUpdate;
  onStarted: () => void;
  onRemoved: () => void;
  /** Why an update would not start; null clears it. */
  onProblem: (problem: string | null) => void;
};

/**
 * What can be done with the module, at the header's top right. For the administrator, on one
 * `mod install` fetched, Update — the newest release when it was installed at one, the newest
 * commit of the branch it was installed from, or another tag's commit again; one installed at a
 * commit stays there and has none — which says what it would update to, or that it is the latest,
 * as `mod outdated` has it; and Remove, which asks in a dialog and says what goes with it. For
 * everyone its documentation: the Docs page's on the module, with the guide's pages on it and
 * everything it brings. An update runs on its own, which the tab follows, and waits while another
 * install runs.
 */
function Actions({ module, usedBy, admin, install, update, onStarted, onRemoved, onProblem }: ActionsProps) {
  const record = admin ? module.installed : undefined;
  const pinned = record !== undefined && record.ref === record.commit;
  // A release, `v<version>`, is updated to the newest release this core can run, which `mod install` takes without a ref.
  const version = record?.ref.startsWith('v') ? tryParse(record.ref.slice(1)) : undefined;
  const release = version !== undefined && !version.prerelease?.length;
  const [updating, setUpdating] = useState(false);
  const [asking, setAsking] = useState(false);
  const target = record && (release ? record.repository : `${record.repository}@${record.ref}`);
  const running = install?.state === 'running' ? install : null;
  const mine = updating || running?.args.includes(target!) === true;

  const start = async () => {
    setUpdating(true);
    onProblem(null);
    try {
      await execCommand(`mod install --background ${shq(target!)}`);
      onStarted();
    } catch (err) {
      onProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  const label = mine
    ? 'Updating'
    : update.state === 'behind'
    ? `Update to ${update.to}`
    : update.state === 'latest'
    ? 'Latest version'
    : update.state === 'checking'
    ? 'Checking for updates'
    : 'Update';

  return (
    <Group gap='xs' wrap='wrap' className='mrx-module-actions'>
      {record && !pinned && (
        <Button
          size='xs'
          variant={update.state === 'behind' ? 'filled' : 'default'}
          leftSection={update.state === 'latest' && !mine ? <IconCheck size={16} /> : <IconRefresh size={16} />}
          loading={mine}
          disabled={!mine && (running !== null || update.state === 'latest' || update.state === 'checking')}
          title={update.state === 'unknown' ? `Could not check for a newer version: ${update.reason}` : undefined}
          onClick={start}
        >
          {label}
        </Button>
      )}
      {record && (
        <Button size='xs' variant='light' color='red' leftSection={<IconTrash size={16} />} disabled={mine} onClick={() => setAsking(true)}>
          Remove
        </Button>
      )}
      <Button component={Link} to={moduleRoute(module.name)} size='xs' variant='default' leftSection={<IconBook2 size={16} />}>Documentation</Button>
      {record && <RemoveDialog module={module} usedBy={usedBy} opened={asking} onClose={() => setAsking(false)} onRemoved={onRemoved} />}
    </Group>
  );
}

type RemoveDialogProps = { module: ModuleEntry; usedBy: ModuleEntry[]; opened: boolean; onClose: () => void; onRemoved: () => void };

/** Remove spelled out before it is done: what goes with the module, and what stops working without it; why it failed, when it did. */
function RemoveDialog({ module, usedBy, opened, onClose, onRemoved }: RemoveDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await execCommand(`mod remove --force ${shq(module.name)}`);
      onClose();
      onRemoved();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={() => {
        if (busy) return;
        setProblem(null);
        onClose();
      }}
      title={`Remove ${module.name}?`}
      icon='trash'
      pattern='danger'
      size='sm'
      floating
    >
      <Stack gap='sm'>
        <Text size='sm'>
          Removing {module.name} stops its services and takes its commands, pages and files away. What it made in the archive stays.
          {usedBy.length > 0 && ` ${usedBy.map((entry) => entry.name).join(', ')} ${usedBy.length > 1 ? 'need' : 'needs'} it and will not work without it.`}
        </Text>
        {problem && (
          <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />}>
            <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
          </Alert>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' disabled={busy} onClick={onClose}>Cancel</Button>
        <Button color='red' leftSection={<IconTrash size={16} />} loading={busy} onClick={remove}>Remove {module.name}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** One line of the details: what it is, and its value beside it. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

type OverviewProps = {
  module: ModuleEntry;
  modules: ModuleEntry[];
  usedBy: ModuleEntry[];
  admin: boolean;
  onChanged: () => void;
  onOpenModule: (name: string) => void;
};

/**
 * The module at a glance: what it needs and what needs it beside its details — where `mod install`
 * fetched it from, at which release and when, or that the deployment provides it, the module API it
 * is written against and the folder it is in — or over them where the panel is narrow; under them,
 * across the panel's width, who has it.
 */
function Overview({ module, modules, usedBy, admin, onChanged, onOpenModule }: OverviewProps) {
  const record = module.installed;
  return (
    <Stack gap='xl'>
      <div className='mrx-module-overview'>
        <Stack gap='lg'>
          <Related
            title='Needs'
            empty='Core only.'
            rows={Object.entries(module.dependencies).map(([name, range]) => ({ name, range, entry: modules.find((each) => each.name === name) }))}
            onOpenModule={onOpenModule}
          />
          {usedBy.length > 0 && (
            <Related
              title='Needed by'
              rows={usedBy.map((entry) => ({ name: entry.name, range: entry.dependencies[module.name], entry }))}
              onOpenModule={onOpenModule}
            />
          )}
        </Stack>
        <Stack gap='sm'>
          <Title order={5}>Details</Title>
          <dl className='mrx-module-facts'>
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
            {module.coreApi && (
              <Fact label='Core API'>
                <Text span size='sm' ff='monospace'>{module.coreApi}</Text>
              </Fact>
            )}
            <Fact label='Folder'>
              <Text span size='sm' ff='monospace'>{module.path}</Text>
            </Fact>
          </dl>
        </Stack>
      </div>
      <AvailableTo module={module} usedBy={usedBy} admin={admin} onChanged={onChanged} />
    </Stack>
  );
}

type RelatedRow = { name: string; range: string; entry?: ModuleEntry };

/**
 * Modules the open one is tied to, a row each: its picture and name, the versions accepted, the
 * version installed and, when it does not work, why; an installed one opens in the panel.
 */
function Related({ title, empty, rows, onOpenModule }: { title: string; empty?: string; rows: RelatedRow[]; onOpenModule: (name: string) => void }) {
  return (
    <Stack gap='sm'>
      <Title order={5}>{title}</Title>
      {rows.length === 0 ? <Text size='sm' c='dimmed'>{empty}</Text> : (
        <Paper withBorder radius='md' className='mrx-module-installed'>
          {rows.map(({ name, range, entry }) => {
            const state = entry && moduleState(entry);
            const body = (
              <Group gap='sm' wrap='nowrap'>
                <ModuleAvatar name={name} size={32} />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={6} align='baseline' wrap='nowrap'>
                    <Text size='sm' fw={600} truncate>{name}</Text>
                    {entry?.version && <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>{entry.version}</Text>}
                  </Group>
                  <Text size='xs' c='dimmed'>
                    Accepts <Text span size='xs' ff='monospace'>{range}</Text>
                  </Text>
                </Box>
                {!entry
                  ? <Badge size='sm' variant='light' color='red' tt='none' style={{ flex: 'none' }}>Not installed</Badge>
                  : state !== 'active' && <Badge size='sm' variant='light' color={STATE_COLOR[state!]} tt='none' style={{ flex: 'none' }}>{STATE_LABEL[state!]}</Badge>}
                {entry && <IconChevronRight size={16} aria-hidden style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />}
              </Group>
            );
            return entry
              ? <UnstyledButton key={name} className='mrx-module-installed-row' onClick={() => onOpenModule(name)}>{body}</UnstyledButton>
              : <Box key={name} className='mrx-module-installed-row'>{body}</Box>;
          })}
        </Paper>
      )}
    </Stack>
  );
}

type AvailableToProps = { module: ModuleEntry; usedBy: ModuleEntry[]; admin: boolean; onChanged: () => void };

/**
 * Who the module is for: everyone, or the groups it is kept to (`mod groups`), whose members alone
 * have its commands, its entries in the navigation and its pages; administrators have every
 * module. For the administrator the groups it may be kept to are boxes to tick, each with its
 * picture and what it is for, saved as each is ticked; none ticked is everyone.
 */
function AvailableTo({ module, usedBy, admin, onChanged }: AvailableToProps) {
  const { users, groups } = useIdentities();
  const saved = module.groups ?? [];
  // The list as it is being saved, while a change is under way, and the group that changed.
  const [pending, setPending] = useState<{ groups: string[]; changed: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = pending?.groups ?? saved;

  // What needs it and is everyone's calls it for people it would be refused to.
  const exposed = chosen.length > 0 ? usedBy.filter((entry) => !entry.groups?.length) : [];
  const summary = saved.length > 0 ? `Members of ${saved.join(', ')}, and administrators.` : 'Everyone who signs in.';

  if (!admin) {
    return (
      <PanelSection title='Available to'>
        <Text size='sm'>{summary}</Text>
      </PanelSection>
    );
  }

  // The groups a module may be kept to: those made here and the one everyone is in, not an
  // account's own; and whatever it is kept to already.
  const own = (group: GroupEntry) => users.some((user) => user.username === group.groupname && user.uid === group.gid);
  const offered = sortGroups(groups.filter((group) => ((group.role === undefined || group.role === 'everyone') && !own(group)) || saved.includes(group.groupname)));
  const items: ChecklistItem[] = [
    ...offered.map((group) => ({
      value: group.groupname,
      label: displayName(group),
      description: group.description || (displayName(group) === group.groupname ? undefined : group.groupname),
      avatar: <GroupAvatar role={group.role} size={24} />,
      checked: chosen.includes(group.groupname),
      busy: pending?.changed === group.groupname,
    })),
    // One it is kept to that is no group any more.
    ...saved.filter((name) => !groups.some((group) => group.groupname === name)).map((name) => ({
      value: name,
      label: name,
      note: 'no such group',
      checked: chosen.includes(name),
      busy: pending?.changed === name,
    })),
  ];

  const toggle = async (name: string, on: boolean) => {
    if (pending) return;
    const next = on ? [...chosen, name] : chosen.filter((each) => each !== name);
    setPending({ groups: next, changed: name });
    setProblem(null);
    try {
      await execCommand(`mod groups ${shq(module.name)} ${next.length > 0 ? next.map(shq).join(' ') : '--everyone'}`);
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <PanelSection
      title='Available to'
      lead='Only members of the groups ticked, and administrators, get its commands, its entries in the navigation and its pages. With none ticked, everyone has it.'
      error={problem}
      onDismiss={() => setProblem(null)}
    >
      <Note>{summary}</Note>
      <Checklist items={items} onToggle={toggle} label={`Groups ${module.name} is kept to`} what='groups' resetKey={module.name} />
      {exposed.length > 0 && (
        <Note warn>
          {exposed.map((entry) => entry.name).join(', ')} {exposed.length > 1 ? 'need' : 'needs'} {module.name} and {exposed.length > 1 ? 'are' : 'is'} everyone's: what{' '}
          {exposed.length > 1 ? 'they run' : 'it runs'} of {module.name} fails for anyone outside these groups.
        </Note>
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
