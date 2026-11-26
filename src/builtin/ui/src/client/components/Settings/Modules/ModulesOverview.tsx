import { Alert, Anchor, Badge, Box, Button, Code, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDownload, IconRefresh, IconServer2 } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import type { ModuleEntry, ModuleInstallJob, OutdatedModule, SupervisedService } from '@ein/api';
import { formatDateTime, formatTime } from '../../../lib/datetime.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { ModuleAvatar } from '../../Identity/ModuleAvatar.tsx';
import { Note } from '../Accounts/PanelParts.tsx';
import { moduleState, STATE_COLOR, STATE_LABEL } from './ModuleList.tsx';
import { capital, jobTitle, ServiceInstallDialog, StateBadge, type Supervisor } from './SupervisedServices.tsx';
import { namesList, type PlannedUpdate, startUpdate, UpdateDialog } from './UpdateDialog.tsx';
import { updateTo, type useModuleUpdates } from './useModuleUpdates.ts';

type Updates = ReturnType<typeof useModuleUpdates>;

/** A row of the overview's lists: a picture, a title over a line or two, and what can be done at its right. */
function Row({ icon, title, lines, aside }: { icon: ReactNode; title: ReactNode; lines: ReactNode; aside?: ReactNode }) {
  return (
    <Box className='mrx-module-installed-row'>
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <Box aria-hidden style={{ flex: 'none', marginTop: 2 }}>{icon}</Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          {title}
          {lines}
        </Box>
        {aside && <Stack gap={6} align='flex-end' style={{ flex: 'none' }}>{aside}</Stack>}
      </Group>
    </Box>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap='sm'>
      <Group justify='space-between' gap='sm' wrap='wrap'>
        <Title order={4}>{title}</Title>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

/** Every module an update of `asked` puts in place, with the ranges it leaves unmet, from `mod outdated`'s answer. */
const plan = (asked: OutdatedModule[], all: OutdatedModule[], installed: ModuleEntry[]): { updates: PlannedUpdate[]; held: string[] } => {
  const names = new Set(asked.flatMap((each) => [each.name, ...(each.together ?? [])]));
  const updates = all.filter((each) => names.has(each.name)).map((each) => ({
    name: each.name,
    from: installed.find((module) => module.name === each.name)?.version ?? each.version,
    to: updateTo(each),
    target: each.target,
  }));
  return { updates, held: [...new Set(asked.flatMap((each) => each.held ?? []))] };
};

type ModulesOverviewProps = {
  modules: ModuleEntry[];
  updates: Updates;
  supervisor: Supervisor;
  /** The install EiN is running, or the last one it ran. */
  install: ModuleInstallJob | null;
  onOpenModule: (name: string, section?: string) => void;
  onOpenServices: () => void;
  /** After an install or a services update was started, so how it stands is asked at once. */
  onStarted: () => void;
};

/**
 * What the Modules tab opens on, for the administrator: everything that can be updated, in one place.
 * The modules with a newer release, each from its version to the new one, the others an update takes
 * with it and what holds it, with Update and What's new (its Changes tab), and Update all for every
 * one nothing holds; EiN and the services beside it with a newer release, with Update and Update all,
 * and those modules need that are not installed, with Install; then what needs a look: modules whose
 * setup failed, repositories that did not answer, how the last install went, with its lines when
 * it failed, and the supervisor's last job when it failed. EiN and its services are listed first, and say so: a module's newer release may need the
 * newer EiN, and is offered once EiN is updated.
 */
export function ModulesOverview({ modules, updates, supervisor, install, onOpenModule, onOpenServices, onStarted }: ModulesOverviewProps) {
  const [confirm, setConfirm] = useState<{ asked: string[]; updates: PlannedUpdate[]; held: string[] } | null>(null);
  const [installing, setInstalling] = useState<SupervisedService | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const all = updates.answer?.modules ?? [];
  const behind = all.filter((each) => each.behind && modules.some((module) => module.name === each.name && module.installed?.commit === each.commit));
  const free = behind.filter((each) => (each.held ?? []).length === 0);
  const heldBack = behind.filter((each) => (each.held ?? []).length > 0);
  const broken = modules.filter((module) => moduleState(module) !== 'active');
  const installRunning = install?.state === 'running';

  const status = supervisor.status;
  const services = status?.configured && !status.error ? status.services : [];
  const newer = services.filter((service) => service.installed && service.available);
  const missing = services.filter((service) => service.wanted && !service.installed && service.optional);
  const down = services.filter((service) => service.installed && service.state && (service.state !== 'running' || (service.health && service.health !== 'healthy')));
  const jobRunning = status?.job?.state === 'running';
  const jobFailed = status?.job?.state === 'failed' ? status.job : null;
  const checked = [
    ...(updates.checkedAt ? [`modules at ${formatTime(updates.checkedAt)}`] : []),
    ...(status?.checkedAt ? [`services at ${formatTime(status.checkedAt)}`] : []),
  ];

  const updateModules = async (asked: OutdatedModule[]) => {
    const planned = plan(asked, all, modules);
    if (planned.updates.length > asked.length || planned.held.length > 0 || asked.length > 1) {
      setConfirm({ asked: asked.map((each) => each.name), ...planned });
      return;
    }
    setBusy(asked[0].name);
    setProblem(null);
    try {
      await startUpdate(planned.updates.map((each) => each.target), false);
      onStarted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const updateServices = async (names: string[]) => {
    setBusy(names.length ? names.join(' ') : 'services');
    setProblem(null);
    try {
      await execCommand(`supervisor update ${names.join(' ')}`.trim());
      supervisor.refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const checkAgain = () => {
    updates.refresh();
    supervisor.refresh();
  };

  return (
    <Stack gap='xl'>
      <Group justify='space-between' align='flex-start' wrap='wrap' gap='sm'>
        <Box style={{ flex: 1, minWidth: 220 }}>
          <Title order={3}>Overview</Title>
          <Text size='sm' c='dimmed'>
            What can be updated, and what needs a look.{checked.length > 0 && ` Checked for newer releases: ${checked.join(', ')}.`}
          </Text>
        </Box>
        <Button size='xs' variant='default' leftSection={<IconRefresh size={16} />} loading={updates.loading} onClick={checkAgain}>
          Check again
        </Button>
      </Group>

      {problem && (
        <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setProblem(null)}>
          <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
        </Alert>
      )}

      <Section
        title='EiN and the services beside it'
        action={newer.length > 0 && (
          <Button
            size='xs'
            leftSection={<IconRefresh size={16} />}
            loading={busy === 'services'}
            disabled={jobRunning || busy !== null}
            onClick={() => void updateServices([])}
          >
            Update all services
          </Button>
        )}
      >
        {status && !status.configured && (
          <Note>
            This installation has no supervisor, so EiN and its services are updated on the machine: <Code>./setup.sh</Code> updates everything.
          </Note>
        )}
        {status?.error && (
          <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='The supervisor does not answer'>
            <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{status.error}</Text>
          </Alert>
        )}
        {(newer.length > 0 || missing.length > 0 || down.length > 0) && (
          <Paper withBorder radius='md' className='mrx-module-installed'>
            {[...newer, ...missing, ...down.filter((service) => !newer.includes(service))].map((service) => (
              <Row
                key={service.name}
                icon={<IconServer2 size={24} color='var(--mantine-color-dimmed)' />}
                title={<Text size='sm' fw={600}>{capital(service.title)}</Text>}
                lines={
                  <Text size='xs' c='dimmed'>
                    {service.available
                      ? `${service.version ?? service.image ?? 'installed'} → ${service.available.version ?? service.available.image}`
                      : !service.installed
                      ? `${namesList(service.wanted!.modules.map((each) => each.module))} ${service.wanted!.modules.length > 1 ? 'need' : 'needs'} it, and it is not installed`
                      : 'It does not run as it should'}
                  </Text>
                }
                aside={
                  <>
                    <StateBadge service={service} />
                    {service.available && (
                      <Button
                        size='compact-sm'
                        leftSection={<IconRefresh size={14} />}
                        loading={busy === service.name}
                        disabled={jobRunning || busy !== null}
                        onClick={() => void updateServices([service.name])}
                      >
                        Update
                      </Button>
                    )}
                    {!service.installed && (
                      <Button size='compact-sm' leftSection={<IconDownload size={14} />} disabled={jobRunning} onClick={() => setInstalling(service)}>
                        Install
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          </Paper>
        )}
        {status?.configured && !status.error && newer.length === 0 && missing.length === 0 && down.length === 0 && (
          <Text size='sm' c='dimmed'>
            <IconCheck size={14} style={{ verticalAlign: '-2px' }} /> EiN and every service run their newest release.
          </Text>
        )}
        {status?.configured && (
          <Anchor component='button' type='button' size='sm' onClick={onOpenServices} style={{ alignSelf: 'flex-start' }}>Every service beside EiN</Anchor>
        )}
      </Section>

      <Section
        title='Modules'
        action={free.length > 0 && (
          <Button
            size='xs'
            leftSection={<IconRefresh size={16} />}
            disabled={installRunning || busy !== null}
            onClick={() => void updateModules(free)}
          >
            Update all modules
          </Button>
        )}
      >
        {newer.length > 0 && behind.length > 0 && (
          <Text size='sm' c='dimmed'>Update EiN first: a module's newer release may need the newer EiN, and is offered here once EiN runs it.</Text>
        )}
        {behind.length > 0 && (
          <Paper withBorder radius='md' className='mrx-module-installed'>
            {behind.map((each) => (
              <Row
                key={each.name}
                icon={<ModuleAvatar name={each.name} size={28} />}
                title={
                  <Group gap={6} wrap='nowrap'>
                    <Anchor component='button' type='button' size='sm' fw={600} c='inherit' onClick={() => onOpenModule(each.name)}>{each.name}</Anchor>
                    <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>{each.version ?? each.commit.slice(0, 9)} → {updateTo(each)}</Text>
                  </Group>
                }
                lines={
                  <>
                    {(each.together ?? []).length > 0 && <Text size='xs' c='dimmed'>Updated together with {namesList(each.together!)}</Text>}
                    {(each.held ?? []).map((why) => (
                      <Text key={why} size='xs' c='orange' style={{ overflowWrap: 'anywhere' }}>
                        <IconAlertTriangle size={12} style={{ verticalAlign: '-1px' }} /> {why}
                      </Text>
                    ))}
                    <Anchor component='button' type='button' size='xs' onClick={() => onOpenModule(each.name, 'changes')}>What's new</Anchor>
                  </>
                }
                aside={
                  <Button
                    size='compact-sm'
                    variant={(each.held ?? []).length > 0 ? 'default' : 'light'}
                    leftSection={<IconRefresh size={14} />}
                    loading={busy === each.name}
                    disabled={installRunning || busy !== null}
                    onClick={() => void updateModules([each])}
                  >
                    Update
                  </Button>
                }
              />
            ))}
          </Paper>
        )}
        {heldBack.length > 0 && free.length > 0 && (
          <Text size='xs' c='dimmed'>Update all leaves out {namesList(heldBack.map((each) => each.name))}, which would stop other modules working.</Text>
        )}
        {updates.loading && !updates.answer && <Text size='sm' c='dimmed'>Checking for newer releases…</Text>}
        {updates.answer && behind.length === 0 && (
          <Text size='sm' c='dimmed'>
            <IconCheck size={14} style={{ verticalAlign: '-2px' }} /> Every module mod install fetched is at its newest release.
          </Text>
        )}
        {updates.error && <Text size='sm' c='red'>The modules could not be checked: {updates.error}</Text>}
      </Section>

      {(broken.length > 0 || (updates.answer?.failed.length ?? 0) > 0 || (install && install.state !== 'running') || jobFailed) && (
        <Section title='Needs a look'>
          <Paper withBorder radius='md' className='mrx-module-installed'>
            {broken.map((module) => (
              <Row
                key={module.name}
                icon={<ModuleAvatar name={module.name} size={28} />}
                title={<Anchor component='button' type='button' size='sm' fw={600} c='inherit' onClick={() => onOpenModule(module.name)}>{module.name}</Anchor>}
                lines={<Text size='xs' c='dimmed' style={{ overflowWrap: 'anywhere' }}>{module.setup?.problems[0] ?? 'Not set up since EiN started'}</Text>}
                aside={<Badge size='sm' variant='light' color={STATE_COLOR[moduleState(module)]} tt='none'>{STATE_LABEL[moduleState(module)]}</Badge>}
              />
            ))}
            {updates.answer?.failed.map((each) => (
              <Row
                key={`check-${each.name}`}
                icon={<ModuleAvatar name={each.name} size={28} />}
                title={<Text size='sm' fw={600}>{each.name}</Text>}
                lines={<Text size='xs' c='dimmed' style={{ overflowWrap: 'anywhere' }}>Could not be checked: {each.reason}</Text>}
              />
            ))}
            {install && install.state !== 'running' && <LastInstall install={install} onOpenModule={onOpenModule} />}
            {jobFailed && (
              <Row
                icon={<IconAlertTriangle size={24} color='var(--mantine-color-red-filled)' />}
                title={<Text size='sm' fw={600}>Failed: {jobTitle(jobFailed, services)}</Text>}
                lines={
                  <Stack gap={2}>
                    <Text size='xs' c='dimmed'>
                      Asked by {jobFailed.by}, {jobFailed.endedAt ? `ended ${formatDateTime(jobFailed.endedAt)}` : `started ${formatDateTime(jobFailed.startedAt)}`}
                    </Text>
                    <Code block mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{jobFailed.lines.slice(-8).join('\n')}</Code>
                  </Stack>
                }
              />
            )}
          </Paper>
        </Section>
      )}

      {confirm && (
        <UpdateDialog
          opened
          asked={confirm.asked}
          updates={confirm.updates}
          held={confirm.held}
          onClose={() => setConfirm(null)}
          onStarted={onStarted}
        />
      )}
      <ServiceInstallDialog service={installing} onClose={() => setInstalling(null)} onStarted={supervisor.refresh} />
    </Stack>
  );
}

/** How the last install went: what it was asked and when, what it put in place, and why it failed, with its last lines. */
function LastInstall({ install, onOpenModule }: { install: ModuleInstallJob; onOpenModule: (name: string) => void }) {
  const done = install.state === 'done';
  const failed = install.result?.failed ?? [];
  return (
    <Row
      icon={done ? <IconCheck size={24} color='var(--mantine-color-teal-filled)' /> : <IconAlertTriangle size={24} color='var(--mantine-color-red-filled)' />}
      title={
        <Text size='sm' fw={600}>
          Last install {done ? 'done' : 'failed'}
          {install.args.length > 0 && <Text span size='xs' c='dimmed' ff='monospace' ml={6}>mod install {install.args.join(' ')}</Text>}
        </Text>
      }
      lines={
        <Stack gap={2}>
          <Text size='xs' c='dimmed'>
            {install.by && `By ${install.by}, `}
            {install.finishedAt ? `ended ${formatDateTime(install.finishedAt)}` : `started ${formatDateTime(install.startedAt)}`}
          </Text>
          {(install.installed ?? []).length > 0 && (
            <Text size='xs'>
              {install.installed!.map((module, index) => (
                <span key={module.name}>
                  {index > 0 && ', '}
                  {module.updated ? 'updated ' : 'installed '}
                  <Anchor component='button' type='button' size='xs' onClick={() => onOpenModule(module.name)}>{module.name}</Anchor>
                  {module.version && ` ${module.version}`}
                </span>
              ))}
            </Text>
          )}
          {failed.map((reason) => <Text key={reason} size='xs' c='red' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reason}</Text>)}
          {!done && install.lines.length > 0 && (
            <Code block mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{install.lines.slice(-8).map((line) => line.text).join('\n')}</Code>
          )}
        </Stack>
      }
    />
  );
}
