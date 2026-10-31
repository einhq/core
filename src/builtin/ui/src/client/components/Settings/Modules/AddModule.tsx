import { Alert, Anchor, Badge, Box, Button, Group, Loader, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { greaterThan, tryParse } from '@std/semver';
import type { ModuleEntry, ModuleInstallResult, ModuleSearch, PublishedModule } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useCommand } from '../../../hooks/useCommand.ts';
import { formatGroupList } from '../../../lib/accounts.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { Done, Note } from '../Accounts/PanelParts.tsx';
import { InstallQuestion } from './InstallQuestion.tsx';

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
  return behind(module, entry) ? { kind: 'behind', entry } : { kind: 'current', entry };
};

/**
 * Whether installing the published module would move the installed one on: it is another commit,
 * and from a release, a higher version, so a module installed from its branch past the newest
 * release is not behind it.
 */
const behind = (module: PublishedModule, entry: ModuleEntry): boolean => {
  if (!module.commit || entry.installed?.commit === module.commit) return false;
  const [published, installed] = [tryParse(module.version ?? ''), tryParse(entry.version ?? '')];
  return !module.release || !published || !installed || greaterThan(published, installed);
};

const short = (commit: string): string => commit.slice(0, 9);

/** What `busy`, `done` and `problem` are keyed by for the install from an address, beside the published repositories. */
const ADDRESS = 'address';

type AddModuleProps = {
  /** The installed modules, for what is installed of each. */
  installed: ModuleEntry[];
  /** After an install, so the list beside it and the shell's navigation are asked again. */
  onInstalled: () => void;
  onOpenModule: (name: string) => void;
};

/**
 * The Modules tab's panel for adding a module. For the administrator, a field that installs from
 * any repository's address, at a branch, tag or commit; under it the published modules: each
 * `module-*` repository of the module sources (`mod search`), with its version and what is installed of it, and for the
 * administrator a button that installs its newest release this EiN can run, or its default branch when it has none,
 * with what it needs, or updates it when that is past what is installed. Install asks first, in its place, who the module is for
 * (`InstallQuestion`); an update keeps whom it was for. A source that does not answer is named
 * above the list.
 */
export function AddModule({ installed, onInstalled, onOpenModule }: AddModuleProps) {
  const admin = useAccessIds()?.admin === true;
  const { data, loading, error, refetch } = useCommand<ModuleSearch>('mod search');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ repository: string; message: string } | null>(null);
  const [done, setDone] = useState<{ repository: string; message: string; names: string[] } | null>(null);
  const [address, setAddress] = useState('');
  // The install whose question — who it is for — is open, by the key `busy` takes.
  const [asking, setAsking] = useState<string | null>(null);

  /** `mod install <target>`, for `groups` (none: everyone), its outcome said under the row `key` names. */
  const run = async (key: string, target: string, say: (names: string[]) => string, groups: string[] = []): Promise<boolean> => {
    setBusy(key);
    setProblem(null);
    setDone(null);
    try {
      const result = await execCommand<ModuleInstallResult>(`mod install ${shq(target)}${groups.length > 0 ? ` --groups ${shq(formatGroupList(groups))}` : ''}`);
      const names = result.installed.map((each) => each.name);
      setDone({ repository: key, message: say(names), names });
      return true;
    } catch (err) {
      setProblem({ repository: key, message: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(null);
      setAsking(null);
      onInstalled();
    }
  };

  /** A published module installed for `groups`, or updated, which keeps whom it is for and asks nothing. */
  const install = (module: PublishedModule, update: boolean, groups: string[] = []) =>
    run(
      module.repository,
      module.repository,
      (names) => update ? 'Updated' : names.length > 1 ? `Installed, with ${names.filter((name) => name !== module.name).join(', ')}` : 'Installed',
      groups,
    );

  const installAddress = async (groups: string[]) => {
    const target = address.trim();
    if (!target) return;
    const installed = await run(ADDRESS, target, (names) => names.length === 0 ? 'Installed at that commit already' : `Installed ${names.join(', ')}`, groups);
    if (installed) setAddress('');
  };

  /** What the last install under `key` came to; with `open`, a link to each module it installed. */
  const outcome = (key: string, open = false) => (
    <>
      {done?.repository === key && (
        <Group mt='xs' gap='xs'>
          <Done>{done.message}</Done>
          {open && done.names.map((name) => <Anchor key={name} component='button' type='button' size='sm' onClick={() => onOpenModule(name)}>Open {name}</Anchor>)}
        </Group>
      )}
      {problem?.repository === key && (
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
    </>
  );

  const modules = data?.modules ?? [];
  return (
    <Stack gap='lg'>
      <Box>
        <Title order={3}>Add a module</Title>
        <Text size='sm' c='dimmed'>
          An installed module is kept in the folder for installed modules, and stays when EiN is upgraded where the deployment mounts that folder from its own disk.
        </Text>
      </Box>

      {admin && (
        <Paper withBorder radius='md' p='sm'>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) setAsking(ADDRESS);
            }}
          >
            <Stack gap='xs'>
              <Box>
                <Title order={5}>From a repository</Title>
                <Text size='sm' c='dimmed'>
                  Any module's repository on GitHub, Forgejo or Gitea, published or not. Without @ and a branch, tag or commit, the newest release this EiN can run is
                  installed, or its default branch when it has none. A private one needs its host's token in the Tokens for module sources setting.
                </Text>
              </Box>
              <Group gap='xs' align='flex-start' wrap='nowrap'>
                <TextInput
                  aria-label="The module's repository"
                  placeholder='https://github.com/owner/module-name@v0.1.0'
                  value={address}
                  onChange={(event) => setAddress(event.currentTarget.value)}
                  disabled={busy !== null || asking === ADDRESS}
                  autoComplete='off'
                  autoCapitalize='off'
                  autoCorrect='off'
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0 }}
                />
                {asking !== ADDRESS && (
                  <Button
                    type='submit'
                    leftSection={<IconDownload size={16} />}
                    disabled={busy !== null || address.trim() === ''}
                    style={{ flex: 'none' }}
                  >
                    Install
                  </Button>
                )}
              </Group>
              {asking === ADDRESS && <InstallQuestion busy={busy === ADDRESS} onInstall={(groups) => void installAddress(groups)} onCancel={() => setAsking(null)} />}
              {outcome(ADDRESS, true)}
            </Stack>
          </form>
        </Paper>
      )}

      <Group justify='space-between' align='flex-start' wrap='nowrap'>
        <Box>
          <Title order={5}>Published</Title>
          <Text size='sm' c='dimmed'>The module repositories of the sources the Module sources setting names.</Text>
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
                  {module.newest && (
                    <Note>
                      {module.newest.version ?? module.newest.release} needs core API {module.newest.coreApi}, which this EiN does not provide;{' '}
                      {module.version ?? module.release} is the newest release it can run.
                    </Note>
                  )}
                </Stack>
                {admin && (standing.kind === 'absent' || standing.kind === 'behind') && asking !== module.repository && (
                  <Button
                    size='xs'
                    variant={standing.kind === 'absent' ? 'filled' : 'light'}
                    leftSection={standing.kind === 'absent' ? <IconDownload size={16} /> : <IconRefresh size={16} />}
                    loading={mine}
                    disabled={busy !== null || module.compatible === false}
                    onClick={() => standing.kind === 'behind' ? void install(module, true) : setAsking(module.repository)}
                    style={{ flex: 'none' }}
                  >
                    {standing.kind === 'absent' ? 'Install' : 'Update'}
                  </Button>
                )}
              </Group>
              {asking === module.repository && (
                <InstallQuestion
                  name={module.name}
                  busy={mine}
                  onInstall={(groups) => void install(module, false, groups)}
                  onCancel={() => setAsking(null)}
                />
              )}
              {outcome(module.repository)}
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
        <Badge
          size='sm'
          variant='light'
          color='yellow'
          tt='none'
          title={`${short(standing.entry.installed!.commit)} installed, ${module.release ?? short(module.commit!)} published`}
        >
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
