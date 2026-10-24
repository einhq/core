import { Alert, Anchor, Badge, Box, Button, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import type { ModuleEntry, ModuleInstallResult, ModuleSearch, PublishedModule } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useCommand } from '../../../hooks/useCommand.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { Done, Note } from '../Accounts/PanelParts.tsx';

/** What is installed of a published module, by which the row says what can be done. */
type Standing =
  | { kind: 'absent' }
  | { kind: 'current'; entry: ModuleEntry }
  | { kind: 'behind'; entry: ModuleEntry }
  /** Installed some other way: the deployment's, or from another repository. */
  | { kind: 'other'; entry: ModuleEntry };

const standingOf = (module: PublishedModule, installed: ModuleEntry[]): Standing => {
  const entry = installed.find((each) => each.name === module.name);
  if (!entry) return { kind: 'absent' };
  if (entry.installed?.repository !== module.repository) return { kind: 'other', entry };
  return module.commit && entry.installed.commit !== module.commit ? { kind: 'behind', entry } : { kind: 'current', entry };
};

const short = (commit: string): string => commit.slice(0, 9);

type PublishedModulesProps = {
  /** The installed modules, for what is installed of each. */
  installed: ModuleEntry[];
  /** After an install, so the list beside it is asked again. */
  onInstalled: () => void;
  onOpenModule: (name: string) => void;
};

/**
 * The published modules, as the Modules tab's panel for adding one: each `module-*` repository of
 * the module sources (`mod search`), with its version and what is installed of it, and for the
 * administrator a button that installs it with what it needs, or updates it when its default
 * branch is past the commit installed. A source that does not answer is named above the list.
 */
export function PublishedModules({ installed, onInstalled, onOpenModule }: PublishedModulesProps) {
  const admin = useAccessIds()?.admin === true;
  const { data, loading, error, refetch } = useCommand<ModuleSearch>('mod search');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ repository: string; message: string } | null>(null);
  const [done, setDone] = useState<{ repository: string; message: string } | null>(null);

  const install = async (module: PublishedModule, update: boolean) => {
    setBusy(module.repository);
    setProblem(null);
    setDone(null);
    try {
      const result = await execCommand<ModuleInstallResult>(`mod install ${shq(module.repository)}`);
      const names = result.installed.map((each) => each.name);
      setDone({
        repository: module.repository,
        message: update ? 'Updated' : names.length > 1 ? `Installed, with ${names.filter((name) => name !== module.name).join(', ')}` : 'Installed',
      });
    } catch (err) {
      setProblem({ repository: module.repository, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      onInstalled();
    }
  };

  const modules = data?.modules ?? [];
  return (
    <Stack gap='lg'>
      <Group justify='space-between' align='flex-start' wrap='nowrap'>
        <Box>
          <Title order={3}>Published modules</Title>
          <Text size='sm' c='dimmed'>
            The module repositories of the sources the Module sources setting names. An installed module is kept in the folder for installed modules, and stays when EiN is
            upgraded where the deployment mounts that folder from its own disk.
          </Text>
        </Box>
        <Button variant='default' size='xs' leftSection={<IconRefresh size={16} />} onClick={refetch} loading={loading && !!data} style={{ flex: 'none' }}>
          Refresh
        </Button>
      </Group>

      {error && <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>{error.message}</Alert>}
      {data?.failed.map((failure) => (
        <Alert key={failure.source} color='yellow' variant='light' icon={<IconAlertTriangle size={16} />} title={`${failure.source} did not answer`}>
          <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{failure.reason}</Text>
        </Alert>
      ))}
      {loading && !data && <Loader size='sm' />}
      {data && modules.length === 0 && <Text size='sm' c='dimmed'>The module sources publish no modules.</Text>}

      <Stack gap='sm'>
        {modules.map((module) => {
          const standing = standingOf(module, installed);
          const mine = busy === module.repository;
          return (
            <Paper key={module.repository} withBorder radius='md' p='sm'>
              <Group justify='space-between' align='flex-start' gap='sm'>
                <Stack gap={2} style={{ flex: '1 1 16rem', minWidth: 0 }}>
                  <Group gap='xs'>
                    {standing.kind === 'absent'
                      ? <Text fw={600}>{module.name}</Text>
                      : <Anchor component='button' type='button' fw={600} onClick={() => onOpenModule(module.name)}>{module.name}</Anchor>}
                    {module.version && <Text size='xs' c='dimmed' ff='monospace'>{module.version}</Text>}
                    <StandingBadge standing={standing} module={module} />
                  </Group>
                  {module.description && <Text size='sm'>{module.description}</Text>}
                  <Anchor href={module.repository} target='_blank' rel='noreferrer' size='xs' c='dimmed' style={{ overflowWrap: 'anywhere' }}>{module.repository}</Anchor>
                  {module.compatible === false && <Note warn>Needs core API {module.coreApi}, which this EiN does not provide.</Note>}
                </Stack>
                {admin && (standing.kind === 'absent' || standing.kind === 'behind') && (
                  <Button
                    size='xs'
                    variant={standing.kind === 'absent' ? 'filled' : 'light'}
                    leftSection={standing.kind === 'absent' ? <IconDownload size={16} /> : <IconRefresh size={16} />}
                    loading={mine}
                    disabled={busy !== null || module.compatible === false}
                    onClick={() => install(module, standing.kind === 'behind')}
                    style={{ flex: 'none' }}
                  >
                    {standing.kind === 'absent' ? 'Install' : 'Update'}
                  </Button>
                )}
              </Group>
              {done?.repository === module.repository && (
                <Box mt='xs'>
                  <Done>{`${done.message}. Its pages appear when this page is reloaded.`}</Done>
                </Box>
              )}
              {problem?.repository === module.repository && (
                <Alert
                  mt='xs'
                  color='red'
                  p='xs'
                  icon={<IconAlertTriangle size={16} />}
                  withCloseButton
                  closeButtonLabel='Dismiss'
                  onClose={() => setProblem(null)}
                >
                  <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem.message}</Text>
                </Alert>
              )}
            </Paper>
          );
        })}
      </Stack>
    </Stack>
  );
}

/** A badge for what is installed of it; none when nothing is. */
function StandingBadge({ standing, module }: { standing: Standing; module: PublishedModule }) {
  switch (standing.kind) {
    case 'absent':
      return null;
    case 'current':
      return <Badge size='sm' variant='light' color='teal' tt='none'>Installed</Badge>;
    case 'behind':
      return (
        <Badge size='sm' variant='light' color='yellow' tt='none' title={`${short(standing.entry.installed!.commit)} installed, ${short(module.commit!)} published`}>
          Update available
        </Badge>
      );
    case 'other':
      return (
        <Badge size='sm' variant='light' color='gray' tt='none' title={standing.entry.installed?.repository ?? standing.entry.path}>
          {standing.entry.installed ? 'Installed from elsewhere' : "The deployment's"}
        </Badge>
      );
  }
}
