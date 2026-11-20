import { Alert, Badge, Box, Button, Code, Group, List, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDownload, IconRefresh, IconServer2 } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleEntry, SupervisedService, SupervisorJob, SupervisorStatus } from '@ein/api';
import { formatDateTime, formatTime } from '../../../lib/datetime.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { Dialog, DialogActions } from '../../Surface/Dialog.tsx';
import { Note } from '../Accounts/PanelParts.tsx';

/** How often `supervisor status` is asked while a job runs, and while none does. */
const RUNNING_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

export type Supervisor = {
  /** The last answer; null until the first. */
  status: SupervisorStatus | null;
  /** Ask again now, after starting a job. */
  refresh: () => void;
  /** The job this page saw running, so one finished long before is not announced. */
  seen: string | null;
};

/**
 * The services beside EiN as the supervisor reports them (`supervisor status`), for the
 * administrator: asked every 3 s while an install or update runs and every 30 s otherwise, and not
 * while the tab is hidden. A job restarts EiN, and the answers that fail meanwhile keep the last one.
 */
export function useSupervisor(enabled: boolean): Supervisor {
  const [status, setStatus] = useState<SupervisorStatus | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const running = useRef(false);
  const [tick, setTick] = useState(0);

  const ask = useCallback(async () => {
    try {
      const answer = await execCommand<SupervisorStatus>('supervisor status');
      setStatus(answer);
      running.current = answer.job?.state === 'running';
      if (answer.job?.state === 'running') setSeen(answer.job.id);
    } catch {
      // EiN is away, as while a job restarts it; the supervisor's own failure is an answer with `error`.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      if (!document.hidden) await ask();
      if (!stopped) timer = setTimeout(loop, running.current ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    const onVisible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void loop();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ask, enabled, tick]);

  return { status, seen, refresh: () => setTick((n) => n + 1) };
}

/** `the media service` → `The media service`. */
const capital = (text: string): string => text[0].toUpperCase() + text.slice(1);

/** What a job does, from its setup.sh options: `Installing the media service`, `Updating EiN and the database`. */
const jobTitle = (job: SupervisorJob, services: SupervisedService[]): string => {
  const title = (name: string) => services.find((service) => service.name === name)?.title ?? name;
  const install = job.args.find((arg) => arg.startsWith('--') && arg !== '--only');
  const only = job.args[job.args.indexOf('--only') + 1];
  if (job.args.includes('--only') && only) {
    const names = only.split(',').map(title);
    return `Updating ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
  }
  return install ? `Installing ${title(install.slice(2))}` : 'Updating every service';
};

/**
 * The supervisor's job, for everyone on the Modules tab: while it runs, what it does, who asked and
 * its last line; once it ends, whether it did, with its last lines when it failed.
 */
export function SupervisorJobAlert({ job, services, onDismiss }: { job: SupervisorJob; services: SupervisedService[]; onDismiss: () => void }) {
  const title = jobTitle(job, services);
  if (job.state === 'running') {
    return (
      <Alert color='blue' variant='light' icon={<Loader size={16} />} title={title}>
        <Stack gap={2}>
          <Text size='sm'>
            Asked by {job.by} at {formatTime(job.startedAt)}. It goes on when this page is closed; EiN restarts during it, and this page comes back with it.
          </Text>
          {job.lines.at(-1) && <Text size='xs' c='dimmed' ff='monospace' style={{ overflowWrap: 'anywhere' }}>{job.lines.at(-1)}</Text>}
        </Stack>
      </Alert>
    );
  }
  const done = job.state === 'done';
  return (
    <Alert
      color={done ? 'teal' : 'red'}
      variant='light'
      icon={done ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
      title={`${done ? 'Done' : 'Failed'}: ${title}`}
      withCloseButton
      closeButtonLabel='Dismiss'
      onClose={onDismiss}
    >
      {!done && (
        <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {job.lines.slice(-8).join('\n')}
        </Code>
      )}
      {done && job.endedAt && <Text size='sm'>Ended at {formatTime(job.endedAt)}.</Text>}
    </Alert>
  );
}

type InstallDialogProps = {
  service: SupervisedService | null;
  onClose: () => void;
  /** After the supervisor took it on. */
  onStarted: () => void;
};

/**
 * What installing a service asks first: what it fetches and what it is given beyond an ordinary
 * container — the graphics card, a capability, this machine's network — as an add-on store rates
 * its add-ons. EiN restarts while it is installed.
 */
function ServiceInstallDialog({ service, onClose, onStarted }: InstallDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useRef(service);
  if (service) shown.current = service;
  const what = shown.current;

  const install = async () => {
    if (!what) return;
    setBusy(true);
    setProblem(null);
    try {
      await execCommand(`supervisor install ${shq(what.name)}`);
      onClose();
      onStarted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={service !== null}
      onClose={() => {
        if (busy) return;
        setProblem(null);
        onClose();
      }}
      title={what ? `Install ${what.title}?` : 'Install'}
      icon='download'
      size='md'
      floating
    >
      {what && (
        <Stack gap='sm'>
          <Text size='sm'>
            The supervisor fetches {what.size ?? 'its image'} and starts it beside EiN.
            {what.wanted && ` ${what.wanted.modules.map((each) => each.module).join(', ')} ${what.wanted.modules.length > 1 ? 'talk' : 'talks'} to it.`}
          </Text>
          {what.gives.length > 0 && (
            <Box>
              <Text size='sm' fw={500}>It is given:</Text>
              <List size='sm' spacing={4} mt={4}>
                {what.gives.map((each) => <List.Item key={each}>{each}</List.Item>)}
              </List>
            </Box>
          )}
          <Text size='sm' c='dimmed'>EiN restarts while it is installed, and is away for a minute or two.</Text>
          {problem && (
            <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />}>
              <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
            </Alert>
          )}
        </Stack>
      )}
      <DialogActions>
        <Button variant='default' disabled={busy} onClick={onClose}>Cancel</Button>
        <Button leftSection={<IconDownload size={16} />} loading={busy} onClick={install}>Install {what?.title}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** A service's state as a badge: not installed, or its container's state and health. */
function StateBadge({ service }: { service: SupervisedService }) {
  if (!service.installed) return <Badge size='sm' variant='light' color='red' tt='none' style={{ flex: 'none' }}>Not installed</Badge>;
  if (!service.state) return <Badge size='sm' variant='light' color='yellow' tt='none' style={{ flex: 'none' }}>No container</Badge>;
  const ok = service.state === 'running' && (!service.health || service.health === 'healthy');
  const label = service.health && service.health !== 'healthy' ? service.health : service.state;
  return <Badge size='sm' variant='light' color={ok ? 'teal' : service.health === 'starting' ? 'blue' : 'red'} tt='none' style={{ flex: 'none' }}>{capital(label)}</Badge>;
}

/** What the modules ask of a service, and whether what runs is another line. */
const askedFor = (service: SupervisedService): string | null => {
  if (!service.wanted) return null;
  const asking = service.wanted.modules.map(({ module, range }) => `${module} ${range}`).join(', ');
  return `Asked for by ${asking}`;
};

type ServicesPanelProps = {
  supervisor: Supervisor;
  admin: boolean;
};

/**
 * The services beside EiN, as the panel the Modules tab opens beside its list: each with its state,
 * the release it runs, and what the modules ask of it; Install for one not installed, and, as for a
 * module, Update to the newer release for one that has one, and Update all when any has. Without a
 * supervisor, how the services are installed and updated on the machine instead.
 */
export function ServicesPanel({ supervisor, admin }: ServicesPanelProps) {
  const { status, refresh } = supervisor;
  const [installing, setInstalling] = useState<SupervisedService | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const running = status?.job?.state === 'running';
  const updatable = status?.services.some((service) => service.installed && service.available) ?? false;

  const update = async (names: string[]) => {
    setBusy(names.join(' ') || 'all');
    setProblem(null);
    try {
      await execCommand(`supervisor update ${names.map(shq).join(' ')}`.trim());
      refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap='lg'>
      <Group justify='space-between' align='flex-start' wrap='wrap' gap='sm'>
        <Box style={{ flex: 1, minWidth: 220 }}>
          <Title order={3}>Services beside EiN</Title>
          <Text size='sm' c='dimmed'>
            The media service, the language model and the devices sidecar run beside EiN, each in a container of its own, and modules talk to them.
          </Text>
        </Box>
        {admin && status?.configured && !status.error && updatable && (
          <Button
            size='sm'
            leftSection={<IconRefresh size={16} />}
            loading={busy === 'all'}
            disabled={running || busy !== null}
            onClick={() => void update([])}
          >
            Update all
          </Button>
        )}
      </Group>
      {!status && <Loader size='sm' />}
      {status && !status.configured && (
        <Note>
          This installation has no supervisor, so setup.sh on the machine installs and updates its services: <Code>./setup.sh --ems</Code> installs the media service, and{' '}
          <Code>./setup.sh</Code> updates everything. An installation from GitHub has one: <Code>./setup.sh --supervisor</Code> adds it.
        </Note>
      )}
      {status?.error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='The supervisor does not answer'>
          <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{status.error}</Text>
        </Alert>
      )}
      {problem && (
        <Alert color='red' p='xs' icon={<IconAlertTriangle size={16} />} withCloseButton closeButtonLabel='Dismiss' onClose={() => setProblem(null)}>
          <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem}</Text>
        </Alert>
      )}
      {status?.configured && status.services.length > 0 && (
        <Paper withBorder radius='md' className='mrx-module-installed'>
          {status.services.map((service) => (
            <Box key={service.name} className='mrx-module-installed-row'>
              <Group gap='sm' wrap='nowrap' align='flex-start'>
                <IconServer2 size={24} aria-hidden style={{ flex: 'none', marginTop: 4, color: 'var(--mantine-color-dimmed)' }} />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={6} align='baseline' wrap='nowrap'>
                    <Text size='sm' fw={600} truncate>{capital(service.title)}</Text>
                    <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>{service.name}</Text>
                  </Group>
                  {service.image && (
                    <Text size='xs' c='dimmed' ff='monospace' truncate title={service.image}>
                      {service.image}
                      {service.version && !service.image.endsWith(`:${service.version}`) ? ` · ${service.version}` : ''}
                    </Text>
                  )}
                  {service.built && <Text size='xs' c='dimmed'>Built {formatDateTime(service.built)}</Text>}
                  {askedFor(service) && <Text size='xs' c='dimmed'>{askedFor(service)}</Text>}
                  {service.unknown && <Text size='xs' c='dimmed'>A service the supervisor does not know, which it cannot install.</Text>}
                </Box>
                <Stack gap={6} align='flex-end' style={{ flex: 'none' }}>
                  <StateBadge service={service} />
                  {admin && !service.installed && service.optional && (
                    <Button
                      size='compact-sm'
                      leftSection={<IconDownload size={14} />}
                      disabled={running || busy !== null}
                      onClick={() => setInstalling(service)}
                    >
                      Install
                    </Button>
                  )}
                  {admin && service.installed && service.available && (
                    <Button
                      size='compact-sm'
                      leftSection={<IconRefresh size={14} />}
                      loading={busy === service.name}
                      disabled={running || busy !== null}
                      title={service.available.image}
                      onClick={() => void update([service.name])}
                    >
                      {service.available.version ? `Update to ${service.available.version}` : 'Update'}
                    </Button>
                  )}
                </Stack>
              </Group>
            </Box>
          ))}
        </Paper>
      )}
      {status?.configured && !status.error && (
        <Text size='xs' c='dimmed'>
          {updatable ? '' : 'Every service runs its newest release. '}
          {status.updateAt ? `A service with a newer release is updated each night at ${status.updateAt}, ` : 'The services are updated only when asked, '}
          and the media service and the sidecar as soon as a module asks for a newer one. A service whose new release does not come up goes back to the one it ran.
          {status.checkedAt && ` Releases last checked ${formatTime(status.checkedAt)}.`}
          {status.checkError && ` GitHub's registry did not answer for every service: ${status.checkError}.`}
          {status.engine && ` The supervisor runs them under ${status.engine}.`}
        </Text>
      )}
      <ServiceInstallDialog service={installing} onClose={() => setInstalling(null)} onStarted={refresh} />
    </Stack>
  );
}

/**
 * The services an installed module talks to beside EiN (`mod.json` `services`), a row each: what it
 * is, the versions accepted, and whether it is installed. With a supervisor, one that is not has
 * Install for the administrator; without one, setup.sh's option that installs it on the machine.
 */
export function NeededServices({ module, supervisor, admin }: { module: ModuleEntry; supervisor: Supervisor; admin: boolean }) {
  const [installing, setInstalling] = useState<SupervisedService | null>(null);
  const ranges = Object.entries(module.serviceRanges ?? {});
  if (ranges.length === 0) return null;
  const status = supervisor.status;
  const running = status?.job?.state === 'running';
  return (
    <Stack gap='sm'>
      <Title order={5}>Services beside EiN</Title>
      <Paper withBorder radius='md' className='mrx-module-installed'>
        {ranges.map(([name, range]) => {
          const service = status?.configured ? status.services.find((each) => each.name === name) : undefined;
          return (
            <Box key={name} className='mrx-module-installed-row'>
              <Group gap='sm' wrap='nowrap'>
                <IconServer2 size={24} aria-hidden style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={6} align='baseline' wrap='nowrap'>
                    <Text size='sm' fw={600} truncate>{service ? capital(service.title) : name}</Text>
                    {service?.version && <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>{service.version}</Text>}
                  </Group>
                  <Text size='xs' c='dimmed'>
                    Accepts <Text span size='xs' ff='monospace'>{range}</Text>
                    {status && !status.configured && (
                      <>
                        {' '}· installed on the machine with <Text span size='xs' ff='monospace'>./setup.sh --{name}</Text>
                      </>
                    )}
                  </Text>
                </Box>
                {service && (
                  <Stack gap={6} align='flex-end' style={{ flex: 'none' }}>
                    <StateBadge service={service} />
                    {admin && !service.installed && service.optional && (
                      <Button
                        size='compact-sm'
                        leftSection={<IconDownload size={14} />}
                        disabled={running}
                        onClick={() => setInstalling(service)}
                      >
                        Install
                      </Button>
                    )}
                  </Stack>
                )}
              </Group>
            </Box>
          );
        })}
      </Paper>
      <ServiceInstallDialog service={installing} onClose={() => setInstalling(null)} onStarted={supervisor.refresh} />
    </Stack>
  );
}

/**
 * Above the Modules tab, for the administrator: the services installed modules talk to that are not
 * installed, with Install for each, so a module installed from here gets what it needs.
 */
export function MissingServices({ supervisor }: { supervisor: Supervisor }) {
  const [installing, setInstalling] = useState<SupervisedService | null>(null);
  const status = supervisor.status;
  if (!status?.configured || status.error) return null;
  const missing = status.services.filter((service) => service.wanted && !service.installed && service.optional);
  if (missing.length === 0) return null;
  const running = status.job?.state === 'running';
  return (
    <>
      {missing.map((service) => (
        <Alert key={service.name} color='yellow' variant='light' icon={<IconAlertTriangle size={16} />} title={`${capital(service.title)} is not installed`}>
          <Group justify='space-between' gap='sm' wrap='wrap'>
            <Text size='sm' style={{ flex: 1, minWidth: 200 }}>
              {service.wanted!.modules.map((each) =>
                each.module
              ).join(', ')} {service.wanted!.modules.length > 1 ? 'talk' : 'talks'} to it, and {service.wanted!.modules.length > 1 ? 'do' : 'does'} not work without it.
            </Text>
            <Button
              size='xs'
              leftSection={<IconDownload size={14} />}
              disabled={running}
              onClick={() =>
                setInstalling(service)}
            >
              Install {service.title}
            </Button>
          </Group>
        </Alert>
      ))}
      <ServiceInstallDialog service={installing} onClose={() => setInstalling(null)} onStarted={supervisor.refresh} />
    </>
  );
}
