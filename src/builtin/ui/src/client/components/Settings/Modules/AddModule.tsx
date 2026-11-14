import { Alert, Anchor, Badge, Box, Button, Group, Paper, Skeleton, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconChevronRight, IconDownload, IconRefresh } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { greaterThan, tryParse } from '@std/semver';
import type { ModuleEntry, ModuleInstallJob, ModuleSearch, PublishedModule } from '@ein/api';
import { useAccessIds } from '../../../hooks/useAccessIds.ts';
import { useCommand } from '../../../hooks/useCommand.ts';
import { formatGroupList } from '../../../lib/accounts.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';
import { Note } from '../Accounts/PanelParts.tsx';
import { InstallQuestion } from './InstallQuestion.tsx';
import { ModuleAvatar } from './ModuleList.tsx';

/** What is installed of a published module, by which the page says what can be done. */
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

/** `https://github.com/einhq/module-archive` → `github.com/einhq/module-archive`. */
const withoutScheme = (url: string): string => url.replace(/^[a-z]+:\/\//i, '');

/** What `busy` and `problem` are keyed by for the install from an address, beside the published repositories. */
const ADDRESS = 'address';

type Listed = { module: PublishedModule; standing: Standing };

type AddModuleProps = {
  /** The installed modules, for what is installed of each. */
  installed: ModuleEntry[];
  /** The install EiN is running, or the last one: while one runs, nothing else is installed. */
  install: ModuleInstallJob | null;
  /** After an install was started, so how it stands is asked at once. */
  onStarted: () => void;
  onOpenModule: (name: string) => void;
};

/**
 * The Modules tab's panel that installs a module. The published modules — each `module-*`
 * repository of the module sources (`mod search`) — in three groups: those with an update and those
 * not installed, a card each with what it is and, for the administrator, Update or Install, which
 * takes its newest release this EiN can run, or its default branch when it has none, with what it
 * needs; and the installed ones, a row each that opens its panel. Install asks first, in its card,
 * who the module is for (`InstallQuestion`); an update keeps whom it was for. At the foot, for the
 * administrator, a field that installs from any repository's address, at a branch, tag or commit.
 * The install runs on its own, which the tab follows; while one runs, nothing else is installed. A
 * source that does not answer is named above the groups.
 */
export function AddModule({ installed, install: current, onStarted, onOpenModule }: AddModuleProps) {
  const admin = useAccessIds()?.admin === true;
  const { data, loading, error, refetch } = useCommand<ModuleSearch>('mod search');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ repository: string; message: string } | null>(null);
  const [address, setAddress] = useState('');
  // The install whose question — who it is for — is open, by the key `busy` takes.
  const [asking, setAsking] = useState<string | null>(null);

  // An install EiN runs, whoever started it, holds every Install and Update.
  const running = current?.state === 'running' ? current : null;

  /**
   * `mod install --background <target>`, for `groups` (none: everyone): the install runs on its own,
   * and the tab says how it stands; why it would not start is said under the card `key` names.
   */
  const run = async (key: string, target: string, groups: string[] = []): Promise<boolean> => {
    setBusy(key);
    setProblem(null);
    try {
      await execCommand(`mod install --background ${shq(target)}${groups.length > 0 ? ` --groups ${shq(formatGroupList(groups))}` : ''}`);
      onStarted();
      return true;
    } catch (err) {
      setProblem({ repository: key, message: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(null);
      setAsking(null);
    }
  };

  /** A published module installed for `groups`, or updated, which keeps whom it is for and asks nothing. */
  const install = (module: PublishedModule, groups: string[] = []) => run(module.repository, module.repository, groups);

  const installAddress = async (groups: string[]) => {
    const target = address.trim();
    if (!target) return;
    if (await run(ADDRESS, target, groups)) setAddress('');
  };

  /** Why the install under `key` would not start. */
  const outcome = (key: string) =>
    problem?.repository === key && (
      <Alert
        color='red'
        p='xs'
        icon={<IconAlertTriangle size={16} />}
        withCloseButton
        closeButtonLabel='Dismiss'
        onClose={() => setProblem(null)}
      >
        <Text size='sm' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{problem.message}</Text>
      </Alert>
    );

  const listed: Listed[] = (data?.modules ?? []).map((module) => ({ module, standing: standingOf(module, installed) }));
  const updates = listed.filter((each) => each.standing.kind === 'behind');
  const absent = listed.filter((each) => each.standing.kind === 'absent');
  const present = listed.filter((each) => each.standing.kind === 'current' || each.standing.kind === 'other');

  /** A module with something to do: what it is, and Install or Update with the question Install asks. */
  const card = ({ module, standing }: Listed) => {
    const mine = busy === module.repository || running?.args.includes(module.repository) === true;
    const update = standing.kind === 'behind';
    return (
      <Paper key={module.repository} withBorder radius='md' p='md' className='mrx-module-card'>
        <Group gap='sm' wrap='nowrap' align='flex-start'>
          <ModuleAvatar size={40} />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group gap={6} align='baseline' wrap='wrap' style={{ rowGap: 0 }}>
              {update
                ? <Anchor component='button' type='button' fw={600} onClick={() => onOpenModule(module.name)}>{module.name}</Anchor>
                : <Text fw={600}>{module.name}</Text>}
              {module.version && <Text size='xs' c='dimmed' ff='monospace'>{module.version}</Text>}
            </Group>
            <Anchor href={module.repository} target='_blank' rel='noreferrer' size='xs' c='dimmed' truncate='end' display='block' title={module.repository}>
              {withoutScheme(module.repository)}
            </Anchor>
          </Box>
        </Group>
        {module.description && <Text size='sm'>{module.description}</Text>}
        {module.compatible === false && <Note warn>Needs core API {module.coreApi}, which this EiN does not provide.</Note>}
        {module.newest && <NewestNote module={module} />}
        <Group justify='space-between' align='center' gap='xs' mt='auto'>
          <Text size='xs' c='dimmed' title={update ? `${short(standing.entry.installed!.commit)} installed, ${module.release ?? short(module.commit!)} published` : undefined}>
            {update ? `${standing.entry.version ?? short(standing.entry.installed!.commit)} installed` : ''}
          </Text>
          {admin && asking !== module.repository && (
            <Button
              size='xs'
              variant={update ? 'light' : 'filled'}
              leftSection={update ? <IconRefresh size={16} /> : <IconDownload size={16} />}
              loading={mine}
              disabled={busy !== null || running !== null || module.compatible === false}
              onClick={() => update ? void install(module) : setAsking(module.repository)}
            >
              {update ? 'Update' : 'Install'}
            </Button>
          )}
        </Group>
        {asking === module.repository && (
          <InstallQuestion
            name={module.name}
            busy={mine}
            onInstall={(groups) => void install(module, groups)}
            onCancel={() => setAsking(null)}
          />
        )}
        {outcome(module.repository)}
      </Paper>
    );
  };

  return (
    <Stack gap='xl'>
      <Stack gap='sm'>
        <Group justify='space-between' align='flex-start' wrap='nowrap'>
          <Box>
            <Title order={3}>Install a module</Title>
            <Text size='sm' c='dimmed'>
              {admin
                ? 'The modules published where the Module sources setting points. A module comes with the modules it needs.'
                : 'The modules published where the Module sources setting points. An administrator installs them.'}
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
        {data && listed.length === 0 && <Note>The module sources publish no modules.</Note>}
        {data && listed.length > 0 && updates.length === 0 && absent.length === 0 && (
          <Note>Every published module is installed, and none has a newer release this EiN can run.</Note>
        )}
      </Stack>

      {loading && !data && (
        <div className='mrx-module-cards' aria-hidden>
          {[0, 1, 2, 3].map((key) => <Skeleton key={key} height={150} radius='md' />)}
        </div>
      )}

      {updates.length > 0 && (
        <Section title='Updates' count={updates.length}>
          <div className='mrx-module-cards'>{updates.map(card)}</div>
        </Section>
      )}

      {absent.length > 0 && (
        <Section title='Not installed' count={absent.length}>
          <div className='mrx-module-cards'>{absent.map(card)}</div>
        </Section>
      )}

      {present.length > 0 && (
        <Section title='Installed' count={present.length}>
          <Paper withBorder radius='md' className='mrx-module-installed'>
            {present.map(({ module, standing }) => (
              <UnstyledButton key={module.repository} className='mrx-module-installed-row' onClick={() => onOpenModule(module.name)}>
                <Group gap='sm' wrap='nowrap'>
                  <ModuleAvatar size={32} />
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6} align='baseline' wrap='nowrap'>
                      <Text size='sm' fw={600} truncate>{module.name}</Text>
                      {standing.kind !== 'absent' && standing.entry.version && (
                        <Text size='xs' c='dimmed' ff='monospace' style={{ flex: 'none' }}>{standing.entry.version}</Text>
                      )}
                    </Group>
                    <Text size='xs' c='dimmed' truncate title={module.description}>{module.description}</Text>
                    {module.newest && <NewestNote module={module} quiet />}
                  </Box>
                  {standing.kind === 'other' && (
                    <Badge size='sm' variant='light' color='gray' tt='none' style={{ flex: 'none' }} title={standing.entry.installed?.repository ?? standing.entry.path}>
                      {standing.entry.installed ? 'Installed from elsewhere' : "The deployment's"}
                    </Badge>
                  )}
                  <IconChevronRight size={16} aria-hidden style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />
                </Group>
              </UnstyledButton>
            ))}
          </Paper>
        </Section>
      )}

      {admin && (
        <Paper withBorder radius='md' p='md'>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) setAsking(ADDRESS);
            }}
          >
            <Stack gap='sm'>
              <Box>
                <Title order={5}>From a repository's address</Title>
                <Text size='sm' c='dimmed'>
                  Any module's repository on GitHub, Forgejo or Gitea, published or not. After @, a branch, tag or commit installs that one; without, the newest release this
                  EiN can run, or the default branch when it has none. A private one needs its host's token in the Tokens for module sources setting.
                </Text>
              </Box>
              <Group gap='xs' align='flex-start' wrap='nowrap'>
                <TextInput
                  aria-label="The module's repository"
                  placeholder='https://github.com/owner/module-name@v0.1.0'
                  value={address}
                  onChange={(event) => setAddress(event.currentTarget.value)}
                  disabled={busy !== null || running !== null || asking === ADDRESS}
                  autoComplete='off'
                  autoCapitalize='off'
                  autoCorrect='off'
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0 }}
                />
                {asking !== ADDRESS && (
                  <Button
                    type='submit'
                    variant='default'
                    leftSection={<IconDownload size={16} />}
                    disabled={busy !== null || running !== null || address.trim() === ''}
                    style={{ flex: 'none' }}
                  >
                    Install
                  </Button>
                )}
              </Group>
              {asking === ADDRESS && <InstallQuestion busy={busy === ADDRESS} onInstall={(groups) => void installAddress(groups)} onCancel={() => setAsking(null)} />}
              {outcome(ADDRESS)}
            </Stack>
          </form>
        </Paper>
      )}
    </Stack>
  );
}

/** One of the page's groups: its heading with how many it holds, over them. */
function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Stack gap='sm'>
      <Group gap='xs'>
        <Title order={5}>{title}</Title>
        <Badge size='sm' variant='light' color='gray' tt='none'>{count}</Badge>
      </Group>
      {children}
    </Stack>
  );
}

/** That its newest release asks for a module API this core does not provide, and which release is taken instead; `quiet` says it as a dimmed line. */
function NewestNote({ module, quiet }: { module: PublishedModule; quiet?: boolean }) {
  const text = `${module.newest!.version ?? module.newest!.release} needs core API ${module.newest!.coreApi}, which this EiN does not provide; ${
    module.version ?? module.release
  } is the newest release it can run.`;
  return quiet ? <Text size='xs' c='dimmed'>{text}</Text> : <Note>{text}</Note>;
}
