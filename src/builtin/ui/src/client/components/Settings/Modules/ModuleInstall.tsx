import { Alert, Anchor, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleInstallJob, ModuleInstallStatus } from '@ein/api';
import { formatCount } from '../../../lib/format.ts';
import { execCommand } from '../../../signals/shell-client.ts';

/** How often `mod status` is asked while an install runs, and while none does. */
const RUNNING_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

/**
 * The module install EiN is running, whoever started it and from wherever (`mod status`), asked
 * every 2s while one runs and every 10s otherwise, and not while the tab is hidden. `seen` is
 * whether this page saw it running, so an install finished long before is not announced;
 * `onFinished` is called when one it saw running ends. `refresh` asks at once, after starting one.
 */
export function useModuleInstall(onFinished: () => void) {
  const [install, setInstall] = useState<ModuleInstallJob | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const running = useRef<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const [tick, setTick] = useState(0);

  const ask = useCallback(async () => {
    try {
      const { install } = await execCommand<ModuleInstallStatus>('mod status');
      setInstall(install);
      if (install?.state === 'running') {
        running.current = install.id;
        setSeen(install.id);
      } else if (running.current !== null) {
        running.current = null;
        finished.current();
      }
    } catch {
      // Asked again on the next tick.
    }
  }, []);

  useEffect(() => {
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
  }, [ask, tick]);

  return { install, seen: install !== null && install.id === seen, refresh: () => setTick((n) => n + 1) };
}

type InstallProgressProps = {
  install: ModuleInstallJob;
  onOpenModule: (name: string) => void;
  onDismiss: () => void;
};

/**
 * The install running, for everyone on the Modules tab: what it was asked, who started it, how
 * many files of the module it is unpacking are in place and its last line; once it ends, what it
 * installed, with a link to each, or why it failed.
 */
export function InstallProgress({ install, onOpenModule, onDismiss }: InstallProgressProps) {
  const asked = `mod install ${install.args.join(' ')}`;
  const last = install.lines.at(-1)?.text.trim();

  if (install.state === 'running') {
    return (
      <Alert color='blue' variant='light' icon={<Loader size={16} />} title={`Installing: ${asked}`}>
        <Stack gap={2}>
          <Text size='sm'>
            Started by {install.by} at {new Date(install.startedAt).toLocaleTimeString()}. It goes on when this page is closed.
          </Text>
          {install.unpacking && <Text size='sm'>{formatCount(install.unpacking.files)} files of {install.unpacking.module} unpacked</Text>}
          {last && <Text size='xs' c='dimmed' ff='monospace' style={{ overflowWrap: 'anywhere' }}>{last}</Text>}
        </Stack>
      </Alert>
    );
  }

  const installed = install.result?.installed ?? [];
  const failed = install.result?.failed ?? [];
  return (
    <Alert
      color={install.state === 'done' ? 'teal' : 'red'}
      variant='light'
      icon={install.state === 'done' ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
      title={install.state === 'done' ? `Done: ${asked}` : `Failed: ${asked}`}
      withCloseButton
      closeButtonLabel='Dismiss'
      onClose={onDismiss}
    >
      <Stack gap={4}>
        {installed.length === 0 && install.state === 'done' && <Text size='sm'>Nothing new: it is installed at that commit already.</Text>}
        {installed.map((module) => (
          <Group key={module.name} gap='xs'>
            <Text size='sm'>{module.updated ? 'Updated' : 'Installed'} {[module.name, module.version].filter(Boolean).join(' ')}</Text>
            <Anchor component='button' type='button' size='sm' onClick={() => onOpenModule(module.name)}>Open {module.name}</Anchor>
          </Group>
        ))}
        {failed.map((reason) => <Text key={reason} size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reason}</Text>)}
      </Stack>
    </Alert>
  );
}
