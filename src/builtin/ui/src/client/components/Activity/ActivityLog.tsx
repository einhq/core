import { Alert, Anchor, Badge, Button, Card, Chip, Group, Skeleton, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { IconAlertTriangle, IconSearch, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { type AccessEvent, type AccessLogEntry, AUDIT_RECENT_DAYS, type AuditEntry, type AuditOp } from '@ein/api';
import { execCommand } from '../../signals/shell-client.ts';
import { shq } from '../../lib/shquote.ts';
import { formatDateTime } from '../../lib/datetime.ts';

/** What the list shows: every kind, or one of them. */
type Kind = 'all' | 'sign-ins' | 'failures' | 'downloads' | 'links' | 'changes';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sign-ins', label: 'Sign-ins' },
  { value: 'failures', label: 'Failures' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'links', label: 'Share links' },
  { value: 'changes', label: 'Changes' },
];

/** The access-log events each kind reads; `undefined` reads every event, an empty list none. */
const KIND_EVENTS: Record<Kind, AccessEvent[] | undefined> = {
  'all': undefined,
  'sign-ins': ['sign-in', 'sign-in-failed', 'sign-out', 'elevate', 'elevate-failed'],
  'failures': ['sign-in-failed', 'elevate-failed'],
  'downloads': ['download', 'download-archive'],
  'links': ['link-open'],
  'changes': [],
};

const EVENT_LABELS: Record<AccessEvent, { label: string; color: string }> = {
  'sign-in': { label: 'signed in', color: 'green' },
  'sign-in-failed': { label: 'sign-in failed', color: 'red' },
  'sign-out': { label: 'signed out', color: 'gray' },
  'elevate': { label: 'became administrator', color: 'orange' },
  'elevate-failed': { label: 'elevation failed', color: 'red' },
  'link-open': { label: 'opened share link', color: 'grape' },
  'download': { label: 'downloaded', color: 'blue' },
  'download-archive': { label: 'downloaded zip', color: 'blue' },
};

const OP_LABELS: Record<AuditOp, string> = {
  create: 'created',
  update: 'changed',
  move: 'moved',
  link: 'linked',
  unlink: 'unlinked',
  delete: 'deleted',
};

/**
 * The filters the commands are run with. Every one narrows; empty ones are left out. `older`
 * reaches past the audit trail's recent days, which `audit` reads unless told otherwise.
 */
type Filters = { kind: Kind; user: string; path: string; from: string; sid: string; since: string | null; until: string | null; pipeline: boolean; older: boolean };

const NO_FILTERS: Filters = { kind: 'all', user: '', path: '', from: '', sid: '', since: null, until: null, pipeline: false, older: false };

/** One line of the list: an access-log record or an audit record, in the same terms. */
type Row = {
  id: string;
  timestamp: number;
  who?: string;
  /** What `--user` takes to narrow to `who`: the name, or the uid of an account that is gone. */
  user?: string;
  label: string;
  color: string;
  path?: string;
  fromPath?: string;
  detail?: string;
  via?: string;
  from?: string;
  sid?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

/** A `YYYY-MM-DD` from the date input as epoch ms at the start of that day here, where the reader is. */
const dayStart = (day: string): number => new Date(`${day}T00:00`).getTime();

const whoOf = (entry: { username?: string; uid?: number }): string | undefined => entry.username ?? (entry.uid !== undefined ? `uid:${entry.uid}` : undefined);
const userOf = (entry: { username?: string; uid?: number }): string | undefined => entry.username ?? entry.uid?.toString();

const accessRow = (entry: AccessLogEntry): Row => ({
  id: entry.id,
  timestamp: entry.timestamp,
  who: whoOf(entry) ?? (entry.event === 'sign-in-failed' ? 'unknown account' : undefined),
  user: userOf(entry),
  ...EVENT_LABELS[entry.event],
  path: entry.path,
  detail: [
    entry.count !== undefined && `${entry.count} files`,
    entry.method,
    entry.reason,
    entry.linkId && `link ${entry.linkId}`,
  ].filter(Boolean).join(' · ') || undefined,
  via: entry.via,
  from: entry.from,
  sid: entry.sid,
});

const auditRow = (entry: AuditEntry): Row => {
  const changed = [...Object.keys(entry.props ?? {}), ...Object.keys(entry.attrs ?? {})];
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    who: whoOf(entry),
    user: userOf(entry),
    label: OP_LABELS[entry.op],
    color: entry.op === 'delete' || entry.op === 'unlink' ? 'red' : 'teal',
    path: entry.path,
    fromPath: entry.fromPath,
    detail: [entry.nodeType, entry.op === 'update' && changed.length > 0 && changed.join(', ')].filter(Boolean).join(' · '),
    via: entry.sid?.startsWith('pipeline:') ? 'pipeline' : undefined,
    sid: entry.sid,
  };
};

/** The two command lines `filters` asks for, `undefined` where that log has nothing to answer with. */
function commandsFor(filters: Filters, limit: number): { access?: string; audit?: string } {
  const common: string[] = ['-n', String(limit)];
  if (filters.path) common.unshift(shq(filters.path));
  if (filters.user) common.push('--user', shq(filters.user));
  if (filters.sid) common.push('--sid', shq(filters.sid));
  if (filters.since) common.push('--since', String(dayStart(filters.since)));
  if (filters.until) common.push('--until', String(dayStart(filters.until) + DAY_MS));

  const events = KIND_EVENTS[filters.kind];
  const access = events?.length === 0
    ? undefined
    : ['access-log', ...common, ...(events ?? []).flatMap((event) => ['--event', event]), ...(filters.from ? ['--from', shq(filters.from)] : [])].join(' ');
  // The audit trail has no client address and no sign-ins: it answers only what changed.
  const audit = filters.kind !== 'all' && filters.kind !== 'changes' || filters.from
    ? undefined
    : ['audit', ...common, ...(filters.pipeline ? [] : ['--no-pipeline']), ...(filters.older ? ['--all'] : [])].join(' ');
  return { access, audit };
}

/** Whether `audit` reads only its recent days for `filters`: neither asked for more nor given a time or session to read. */
const auditWindowed = (filters: Filters): boolean => !filters.older && !filters.since && !filters.until && !filters.sid;

/**
 * The access log and the audit trail as one list, newest first: who signed in or out, opened a
 * share link or downloaded what, and who changed what, filtered on the server by the commands
 * `access-log` and `audit`. A user, session, path or address in a row narrows the list to it.
 */
export function ActivityLog() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const run = new AbortController();
    const { access, audit } = commandsFor(filters, limit);
    Promise.all([
      access ? execCommand<AccessLogEntry[]>(access, { signal: run.signal }) : [],
      audit ? execCommand<AuditEntry[]>(audit, { signal: run.signal }) : [],
    ]).then(([accessEntries, auditEntries]) => {
      if (run.signal.aborted) return;
      const merged = [...accessEntries.map(accessRow), ...auditEntries.map(auditRow)].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1));
      setMore(accessEntries.length === limit || auditEntries.length === limit);
      setRows(merged.slice(0, limit));
      setError(null);
    }).catch((err) => {
      if (!run.signal.aborted) setError(err instanceof Error ? err : new Error(String(err)));
    });
    return () => run.abort();
  }, [filters, limit]);

  /** Apply `change` at once, to the draft as well as to what is shown. */
  const narrow = (change: Partial<Filters>) => {
    setDraft((current) => ({ ...current, ...change }));
    setFilters((current) => ({ ...current, ...change }));
    setLimit(PAGE);
  };

  const search = () => {
    setFilters(draft);
    setLimit(PAGE);
  };

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const field = (key: 'user' | 'path' | 'from' | 'sid', placeholder: string) => (
    <TextInput
      size='xs'
      placeholder={placeholder}
      value={draft[key]}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraft((current) => ({ ...current, [key]: value }));
      }}
      onKeyDown={(event) => event.key === 'Enter' && search()}
      style={{ flex: '1 1 140px' }}
    />
  );

  return (
    <Stack gap='md'>
      <Card>
        <Stack gap='sm'>
          {/* Chips rather than a segmented control: six of them wrap on a phone instead of being cut off. */}
          <Chip.Group value={filters.kind} onChange={(kind) => narrow({ kind: kind as Kind })}>
            <Group gap={6}>
              {KINDS.map((kind) => <Chip key={kind.value} value={kind.value} size='xs'>{kind.label}</Chip>)}
            </Group>
          </Chip.Group>
          <Group gap='xs' align='flex-end'>
            {field('user', 'User')}
            {field('path', 'Path, e.g. /archive/Summer')}
            {field('from', 'Address')}
            {field('sid', 'Session')}
            <DateInput size='xs' placeholder='From day' clearable value={draft.since} onChange={(since) => narrow({ since })} style={{ flex: '0 1 130px' }} />
            <DateInput size='xs' placeholder='To day' clearable value={draft.until} onChange={(until) => narrow({ until })} style={{ flex: '0 1 130px' }} />
            <Button size='xs' leftSection={<IconSearch size={14} />} onClick={search}>Search</Button>
            {filtered && (
              <Button size='xs' variant='subtle' leftSection={<IconX size={14} />} onClick={() => narrow(NO_FILTERS)}>
                Clear
              </Button>
            )}
          </Group>
          {(filters.kind === 'all' || filters.kind === 'changes') && (
            <Switch
              size='xs'
              label='Include what pipelines derived: thumbnails, faces, text and the like'
              checked={filters.pipeline}
              onChange={(event) => narrow({ pipeline: event.currentTarget.checked })}
            />
          )}
        </Stack>
      </Card>

      {error && (
        <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
          {error.message}
        </Alert>
      )}

      <Card>
        {!rows
          ? (
            <Stack gap='xs'>
              {[0, 1, 2, 3].map((key) => <Skeleton key={key} height={16} />)}
            </Stack>
          )
          : rows.length === 0
          ? <Text c='dimmed'>Nothing recorded{filtered ? ' that matches' : ' yet'}</Text>
          : (
            <Table.ScrollContainer minWidth={760}>
              <Table striped verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>When</Table.Th>
                    <Table.Th>Who</Table.Th>
                    <Table.Th>What</Table.Th>
                    <Table.Th>Where</Table.Th>
                    <Table.Th>From</Table.Th>
                    <Table.Th>Session</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Text size='xs' ff='monospace' style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.timestamp)}</Text>
                      </Table.Td>
                      <Table.Td>
                        {row.user ? <Anchor size='xs' onClick={() => narrow({ user: row.user! })}>{row.who}</Anchor> : <Text size='xs' c='dimmed'>{row.who ?? '—'}</Text>}
                      </Table.Td>
                      <Table.Td>
                        {/* Never cut short: the column keeps the badge's width when the table is narrow. */}
                        <Badge size='xs' variant='light' color={row.color} styles={{ root: { maxWidth: 'none', overflow: 'visible' }, label: { overflow: 'visible' } }}>
                          {row.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ maxWidth: 360 }}>
                        {row.path && (
                          <Anchor size='xs' ff='monospace' onClick={() => narrow({ path: row.path! })} style={{ wordBreak: 'break-all' }}>
                            {row.fromPath ? `${row.fromPath} → ${row.path}` : row.path}
                          </Anchor>
                        )}
                        {row.detail && <Text size='xs' c='dimmed' lineClamp={2}>{row.detail}</Text>}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap='nowrap'>
                          {row.via && <Text size='xs' c='dimmed'>{row.via}</Text>}
                          {row.from && <Anchor size='xs' ff='monospace' onClick={() => narrow({ from: row.from! })}>{row.from}</Anchor>}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {row.sid && (
                          <Tooltip label={row.sid} withArrow>
                            <Anchor size='xs' ff='monospace' onClick={() => narrow({ sid: row.sid! })}>{row.sid.slice(-8)}</Anchor>
                          </Tooltip>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        {rows && more && (
          <Group justify='center' mt='sm'>
            <Button size='xs' variant='light' onClick={() => setLimit((current) => current + PAGE)}>Show more</Button>
          </Group>
        )}
        {rows && !more && commandsFor(filters, limit).audit && auditWindowed(filters) && (
          <Group justify='center' gap='xs' mt='sm'>
            <Text size='xs' c='dimmed'>Changes from the last {AUDIT_RECENT_DAYS} days.</Text>
            <Button size='xs' variant='light' onClick={() => narrow({ older: true })}>Show older changes</Button>
          </Group>
        )}
      </Card>
    </Stack>
  );
}
