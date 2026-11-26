import { Alert, Anchor, Badge, Box, Button, Collapse, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconArrowUp, IconCheck } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { ChangelogCommit, ModuleChangelog as Changelog, ModuleEntry } from '@ein/api';
import { formatDate } from '../../../lib/datetime.ts';
import { shq } from '../../../lib/shquote.ts';
import { execCommand } from '../../../signals/shell-client.ts';

/** How many commits are asked at first, and how many more each time Older is pressed. */
const PAGE = 50;
/** As many as `mod changelog` gives. */
const MOST = 500;

/** A Conventional Commits subject's parts: `fix(keel)!: a knot holds`. */
const SUBJECT = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;

const TYPE_COLOR: Record<string, string> = { feat: 'teal', fix: 'orange', perf: 'grape' };

/** A release's own commit, which the list draws as the line that starts that version. */
const isRelease = (commit: ChangelogCommit): boolean => /^chore\(release\)/.test(commit.subject);

/** One commit: its subject, with its kind as a badge when it says one, its date, tags and id, and its body under Details. */
function CommitRow({ commit }: { commit: ChangelogCommit }) {
  const [open, setOpen] = useState(false);
  const parts = SUBJECT.exec(commit.subject);
  const [type, scope, breaking, text] = parts ? [parts[1], parts[2], parts[3], parts[4]] : [undefined, undefined, undefined, commit.subject];
  return (
    <Box className='mrx-module-installed-row mrx-changelog-row' data-coming={commit.coming || undefined} data-installed={commit.installed || undefined}>
      <Group gap={6} wrap='nowrap' align='flex-start'>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' fw={500} style={{ overflowWrap: 'anywhere' }}>
            {breaking && <Badge component='span' size='xs' radius='sm' color='red' variant='light' tt='none' mr={4} style={{ verticalAlign: '1px' }}>breaking</Badge>}
            {type && (
              <Badge component='span' size='xs' radius='sm' color={TYPE_COLOR[type] ?? 'gray'} variant='light' tt='none' mr={6} style={{ verticalAlign: '1px' }}>
                {type}
                {scope ? ` · ${scope}` : ''}
              </Badge>
            )}
            {text}
          </Text>
          <Group gap={8} wrap='wrap' style={{ rowGap: 2 }}>
            {commit.date && <Text size='xs' c='dimmed'>{formatDate(commit.date)}</Text>}
            <Text size='xs' c='dimmed' ff='monospace' title={commit.commit}>{commit.commit.slice(0, 9)}</Text>
            {commit.tags.map((tag) => <Badge key={tag} size='xs' radius='sm' variant='outline' color='gray' tt='none' ff='monospace'>{tag}</Badge>)}
            {commit.installed && <Badge size='xs' radius='sm' color='teal' tt='none' leftSection={<IconCheck size={10} />}>Installed</Badge>}
            {commit.body && (
              <Anchor component='button' type='button' size='xs' onClick={() => setOpen((was) => !was)} aria-expanded={open}>
                {open ? 'Less' : 'Details'}
              </Anchor>
            )}
          </Group>
          {commit.body && (
            <Collapse expanded={open}>
              <Text size='xs' c='dimmed' mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{commit.body}</Text>
            </Collapse>
          )}
        </Stack>
      </Group>
    </Box>
  );
}

/** A release's commit, as the line that heads the commits it releases: its version, and when. */
function ReleaseLine({ commit }: { commit: ChangelogCommit }) {
  const version = commit.tags[0] ?? commit.subject.replace(/^chore\(release\):\s*/, '');
  return (
    <Box className='mrx-module-installed-row mrx-changelog-release' data-coming={commit.coming || undefined} data-installed={commit.installed || undefined}>
      <Group gap='xs' wrap='wrap'>
        <Badge size='sm' radius='sm' variant='default' tt='none' ff='monospace' fw={600}>{version}</Badge>
        {commit.date && <Text size='xs' c='dimmed'>released {formatDate(commit.date)}</Text>}
        {commit.installed && <Badge size='xs' radius='sm' color='teal' tt='none' leftSection={<IconCheck size={10} />}>Installed</Badge>}
      </Group>
    </Box>
  );
}

function Commits({ commits }: { commits: ChangelogCommit[] }) {
  return (
    <Paper withBorder radius='md' className='mrx-module-installed'>
      {commits.map((commit) => isRelease(commit) ? <ReleaseLine key={commit.commit} commit={commit} /> : <CommitRow key={commit.commit} commit={commit} />)}
    </Paper>
  );
}

/**
 * The module's Changes tab: its repository's commits (`mod changelog`), newest first, in two
 * parts — what an update would bring, above the installed version, and the installed commit with
 * those before it — each release's commit drawn as the line that starts it. A commit says its kind
 * (feat, fix, perf, breaking) when its subject does, and opens its body under Details. Older asks
 * for more.
 */
export function ModuleChangelog({ module }: { module: ModuleEntry }) {
  const [limit, setLimit] = useState(PAGE);
  const [answer, setAnswer] = useState<Changelog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const run = new AbortController();
    setLoading(true);
    execCommand<Changelog>(`mod changelog ${shq(module.name)} --limit ${limit}`, { signal: run.signal })
      .then((next) => {
        setAnswer(next);
        setError(null);
      })
      .catch((err) => {
        if (!run.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!run.signal.aborted) setLoading(false);
      });
    return () => run.abort();
  }, [module.name, limit]);

  if (error) {
    return (
      <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='Its changes could not be read'>
        <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{error}</Text>
      </Alert>
    );
  }
  if (!answer) return <Loader size='sm' />;

  const coming = answer.commits.filter((each) => each.coming);
  const rest = answer.commits.filter((each) => !each.coming);
  const reached = answer.commits.some((each) => each.installed);
  const changes = coming.filter((each) => !isRelease(each)).length;
  const installed = answer.installed.version ?? answer.installed.commit.slice(0, 9);

  return (
    <Stack gap='lg'>
      <Text size='sm' c='dimmed'>
        From <Text span size='sm' ff='monospace'>{answer.repository.replace(/^[a-z]+:\/\//i, '')}</Text>.{' '}
        {answer.repository.includes('github.com')
          ? 'Its history on GitHub is one summary for each day the module was published.'
          : 'Each commit is one change, as it was made.'}
      </Text>
      {coming.length > 0 && (
        <Stack gap='xs'>
          <Group gap='xs'>
            <IconArrowUp size={18} color='var(--mantine-primary-color-filled)' aria-hidden />
            <Title order={5}>Coming with {answer.latest.version ?? answer.latest.commit.slice(0, 9)}</Title>
            <Text size='sm' c='dimmed'>
              {changes === 0 ? 'the release of what is installed' : `${changes}${answer.more && !reached ? '+' : ''} ${changes === 1 ? 'change' : 'changes'} not installed`}
            </Text>
          </Group>
          <Commits commits={coming} />
        </Stack>
      )}
      <Stack gap='xs'>
        <Group gap='xs'>
          <IconCheck size={18} color='var(--mantine-color-teal-filled)' aria-hidden />
          <Title order={5}>Installed: {installed}</Title>
          {coming.length === 0 && <Text size='sm' c='dimmed'>nothing newer to install</Text>}
        </Group>
        {rest.length > 0
          ? <Commits commits={rest} />
          : <Text size='sm' c='dimmed'>The installed commit is older than the {answer.commits.length} newest; Older lists more.</Text>}
      </Stack>
      {answer.more && limit < MOST && (
        <Group>
          <Button size='xs' variant='default' loading={loading} onClick={() => setLimit((was) => Math.min(was + PAGE, MOST))}>Older</Button>
        </Group>
      )}
    </Stack>
  );
}
