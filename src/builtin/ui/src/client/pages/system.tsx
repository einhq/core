import { Alert, Badge, Container, Group, SimpleGrid, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconGauge, IconHeartbeat, IconPlugConnectedX, IconStack2, IconTerminal2 } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useSearchParams } from 'react-router-dom';
import {
  ActiveInstances,
  EntityDetailHeader,
  HealthBadge,
  HealthSummary,
  HostMetrics,
  InstanceInfo,
  LogTail,
  PipelineMatrix,
  RecentErrors,
  RoutePanel,
  ServicesHealth,
  TablerIcon,
  TierUsage,
  UnservableKinds,
  WorkKinds,
  WorkSummary,
} from '@ein/ui/components';
import type { DiskUsage, HealthAnswer, HostMetrics as Metrics, LogLine, PoolStatAnswer, ServiceEntry, SystemInfo } from '@ein/api';
import { usePipelineOverview, usePipelines, usePolledCommand } from '@ein/ui/hooks';
import { panelRoute, panelsOf, shellClientConnected } from '@ein/ui/signals';

/** Must match pipeline-overview's BUCKET_DIGITS (10^(13-7) ms) and window. */
const BUCKET_MS = 1_000_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The dashboard's own tabs; a module's are `system.tabs` panels (ems's media service), drawn after Work. */
const TABS = ['overview', 'work', 'services', 'log'] as const;
type SystemTab = string;

const isTab = (value: string | null): value is SystemTab =>
  value !== null && ((TABS as readonly string[]).includes(value) || panelsOf('system.tabs').some((panel) => panel.id === value));

/**
 * The system dashboard.
 *
 * Independent fetches, deliberately: the pipeline half refetches when the
 * pipeline subtree changes (idle costs nothing), the host half on a 10s timer
 * (there is no event behind a CPU reading). Merging them into one command would
 * force one of the two to run at the wrong rate.
 *
 * The host half is the ordinary commands a shell would run — `health`, `host-metrics`,
 * `df`, `system-info`, `pool-stat`, `service-list --detail`, `dmesg` — one poll
 * each, and there is no page-wide loader: every card draws its own placeholder
 * until the answer it depends on is in, so the CPU tile does not wait on the
 * slowest thing on the page — a cold service probe, or a pipeline count. A command is polled only
 * while a tab showing it is open, except `health`, `host-metrics` and `pool-stat`: the
 * header badges and the unservable alarm qualify every tab.
 *
 * Tabs, ordered by how quickly a problem needs to be seen: the machine's vital
 * signs and what the work is doing first, then the work in detail, then the
 * things you go looking for once something is already wrong.
 */
export default function SystemPage() {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: SystemTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as SystemTab : 'overview';

  const { data: pipeline, error: pipelineError } = usePipelineOverview();
  const { data: host, error: hostError } = usePolledCommand<Metrics>('host-metrics');
  const { data: pools, error: poolsError } = usePolledCommand<PoolStatAnswer[]>('pool-stat');
  const { data: health } = usePolledCommand<HealthAnswer>('health');
  const { data: disk, error: diskError } = usePolledCommand<DiskUsage>('df', tab === 'overview');
  const { data: info, error: infoError } = usePolledCommand<SystemInfo>('system-info', tab === 'overview');
  const { data: services, error: servicesError, refetch: refetchServices } = usePolledCommand<ServiceEntry[]>('service-list --detail', tab === 'services');
  const { data: problems, error: problemsError } = usePolledCommand<LogLine[]>('dmesg --level warn -n 10', tab === 'log');
  // Definitions, fetched once rather than polled — a trigger changes only when someone edits a
  // pipeline, so this costs one command for the life of the page.
  const { data: definitions } = usePipelines();
  const connected = shellClientConnected.value;

  const instances = pipeline?.instances;
  const queues = pipeline?.queues ?? [];
  const completions = pipeline?.completions ?? [];

  // What each pipeline still has waiting, keyed by name for the per-pipeline table.
  //
  // The intake pool's kinds are named after pipelines — one matched trigger per instance it has
  // yet to create — so this is how much each pipeline has not started: the breakdown `pool-stat`
  // prints in a shell.
  const pipelineTriggers = Object.fromEntries(definitions.map((def) => [def.name, def.triggerRules ?? def.triggers]));

  // Every defined pipeline gets a row, even one that has never run.
  //
  // The counts come from aggregating instances, so a pipeline with none would be absent — a
  // freshly defined one invisible at exactly the moment someone wants to know whether it took,
  // which reads as "it did not install". A row of zeroes says "nothing has matched it yet".
  const rows = [...(instances?.byPipeline ?? [])];
  const named = new Set(rows.map((row) => row.pipeline));
  for (const def of definitions) {
    if (named.has(def.name)) continue;
    rows.push({ pipeline: def.name, total: 0, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 });
  }
  rows.sort((a, b) => a.pipeline.localeCompare(b.pipeline));

  // Work that failed every delivery attempt and will not be retried. Surfaced on the pipeline
  // table: it is the only place a dropped job is visible, and silence about dropped work is the
  // wrong default.
  const deadLettered = queues.reduce((sum, queue) => sum + queue.deadLettered, 0);

  // From `pool-stat`, not `pipeline.pools` — only `pool-stat` carries per-kind rates.
  const pipelineBacklog: Record<string, { left: number; perHour?: number; inPerHour?: number; etaMs?: number }> = Object.fromEntries(
    (pools?.find((pool) => pool.role === 'intake')?.kinds ?? [])
      .map((kind) => [kind.kind, {
        left: kind.ready + kind.claimed,
        // `In` is the intake pool's arrival rate for this pipeline — work appearing for it.
        inPerHour: kind.inPerHour,
      }]),
  );

  // `Out` is what the pipeline *finishes*, which is a different counter from the intake pool's
  // throughput for the same name. The pool's rate is how fast triggers become instances: near
  // identical for every pipeline because one trigger loop feeds them all, and saying nothing
  // about whether the work is being done. The ETA divides the backlog by this, not by that.
  for (const entry of instances?.byPipeline ?? []) {
    const row = pipelineBacklog[entry.pipeline];
    if (!row) continue;
    row.perHour = entry.completedPerHour;
    row.etaMs = entry.completedPerHour && entry.completedPerHour > 0 ? (row.left / entry.completedPerHour) * 3600_000 : undefined;
  }

  // Every segment counts instances, which is what makes the 100% bar mean something. Cancelled
  // is a segment of its own: counted as failed it reads as a fault that `health` does not find.
  const counts = {
    completed: instances?.byStatus.completed ?? 0,
    queued: instances?.byStatus.queued ?? 0,
    running: instances?.byStatus.running ?? 0,
    failed: instances?.byStatus.failed ?? 0,
  };

  // Hidden tabs are not fetched, so their errors would only be stale ones.
  const error = pipelineError ?? hostError ?? poolsError ?? (tab === 'overview' ? diskError ?? infoError : null) ??
    (tab === 'services' ? servicesError : null) ?? (tab === 'log' ? problemsError : null);

  // The tab lives in the URL so a view can be linked to directly.
  // `keepMounted={false}` is load-bearing rather than cosmetic here: the
  // log tab holds an open server-side tail, and it must not keep pumping
  // for a panel nobody is looking at.
  return (
    <Tabs
      value={tab}
      onChange={(value) => setSearchParams(value && value !== 'overview' ? { tab: value } : {}, { replace: true })}
      keepMounted={false}
    >
      <EntityDetailHeader
        eyebrow={
          <Group gap='xs'>
            {
              /* All three qualify every tab, so they sit in the header, above its title. The
                pipeline half has no polling, so a dead socket is a frozen page and nothing else
                would say so. */
            }
            <HealthBadge health={health} />
            {!connected && (
              <Tooltip label='Reconnecting — figures below are from the last update' withArrow>
                <Badge color='yellow' variant='filled' leftSection={<IconPlugConnectedX size={12} />}>offline</Badge>
              </Tooltip>
            )}
            {host && !host.sampled && (
              <Tooltip label='metrics-sampler has not written anything yet — host charts fill in within a minute' withArrow>
                <Badge color='blue' variant='filled'>warming up</Badge>
              </Tooltip>
            )}
          </Group>
        }
        title='System dashboard'
        tabs={
          <Tabs.List>
            <Tabs.Tab value='overview' leftSection={<IconGauge size={16} />}>Overview</Tabs.Tab>
            <Tabs.Tab value='work' leftSection={<IconStack2 size={16} />}>Work</Tabs.Tab>
            {panelsOf('system.tabs').map((panel) => (
              <Tabs.Tab key={panel.id} value={panel.id} leftSection={<TablerIcon name={panel.icon ?? 'puzzle'} size={16} />}>{panel.label}</Tabs.Tab>
            ))}
            <Tabs.Tab value='services' leftSection={<IconHeartbeat size={16} />}>Services</Tabs.Tab>
            <Tabs.Tab value='log' leftSection={<IconTerminal2 size={16} />}>Log</Tabs.Tab>
          </Tabs.List>
        }
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            Running jobs, waiting work, and when it will be done
          </Text>
        }
        flowContent
      />

      <Container px='md' py='lg'>
        <Stack gap='lg'>
          {error && (
            <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
              {error.message}
            </Alert>
          )}

          {
            /* Above the tabs, beside the errors, because it qualifies every one of them: a
            backlog nothing will drain makes the work tab's ETA a lie and the overview's
            workload bar a picture of a queue that only grows. It is an alarm, and an alarm
            behind a tab would be silence. */
          }
          {pools && <UnservableKinds pools={pools} definitions={definitions} />}

          <Tabs.Panel value='overview'>
            <Stack gap='lg'>
              {/* What makes the header's verdict other than healthy, when something does (`health`). */}
              <HealthSummary health={health} />

              {
                /* A module's gauges sit beside the host's (`system.overview` panels: ems's GPU),
                  drawn by the module from its own series. */
              }
              <SimpleGrid cols={{ base: 1, md: panelsOf('system.overview').length > 0 ? 2 : 1 }} spacing='sm'>
                <HostMetrics cpu={host?.cpu} memory={host?.memory} loading={!host} />
                {panelsOf('system.overview').map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} />)}
              </SimpleGrid>

              <WorkSummary
                counts={pipeline ? counts : undefined}
                cancelled={instances?.byStatus.cancelled}
                total={instances?.total}
                completions={completions}
                bucketMs={BUCKET_MS}
                windowMs={WINDOW_MS}
              />

              <TierUsage tiers={disk?.tiers} databaseBytes={disk?.databaseBytes} />
              <InstanceInfo instance={info ?? undefined} databaseBytes={disk?.databaseBytes} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value='work'>
            <Stack gap='lg'>
              {
                /* The table is the section — no heading, because the tab already names it,
                  and no summary card above it, because its footer carries the sums. What is
                  executing sits underneath: it is the detail behind the Running column. */
              }
              <PipelineMatrix
                rows={rows}
                loading={!pipeline}
                backlogLoading={!pools}
                backlog={pipelineBacklog}
                deadLettered={deadLettered}
                triggers={pipelineTriggers}
              />

              {/* Where the time goes: the pools the slow steps run out of, per kind of job. */}
              <WorkKinds pools={pools} />

              <ActiveInstances active={pipeline?.active} quiet={pipeline?.quiet} quietMs={pipeline?.quietMs} />
            </Stack>
          </Tabs.Panel>

          {panelsOf('system.tabs').map((panel) => (
            <Tabs.Panel key={panel.id} value={panel.id}>
              <RoutePanel path={panelRoute(panel)} />
            </Tabs.Panel>
          ))}

          <Tabs.Panel value='services'>
            {
              /* Starting or stopping a service changes what the next poll would
                have shown anyway, but ten seconds is long enough to look like
                the button did nothing. */
            }
            <ServicesHealth services={services ?? undefined} onChanged={refetchServices} />
          </Tabs.Panel>

          <Tabs.Panel value='log'>
            <Stack gap='lg'>
              {
                /* Pinned above the stream: the tail answers "what is happening",
                  which is not the same question as "did anything go wrong while
                  I was not watching". */
              }
              <RecentErrors errors={problems ?? undefined} />
              <LogTail />
            </Stack>
          </Tabs.Panel>
        </Stack>
      </Container>
    </Tabs>
  );
}
