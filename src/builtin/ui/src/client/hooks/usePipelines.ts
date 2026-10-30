import { PIPELINE_INSTANCES_PATH as INSTANCES_PATH } from '@ein/paths';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shq } from '../lib/shquote.ts';
import { execCommand, type NodeEventFilter } from '../signals/shell-client.ts';
import { useEventDrivenData, useNodeEvents } from './useNodeEvents.ts';
import type { PipelineOverview } from '@ein/api';
import type { InstancePage, PipelineInstance, PipelineInstanceStatus as PipelineStatus, PipelineStepStatus as PipelineStep, PipelineSummary as PipelineDef } from '@ein/api';
export type { InstancePage, PipelineDef, PipelineInstance, PipelineStatus, PipelineStep };
export type { PipelineOverview, PipelineRow } from '@ein/api';

/** Where instance and step nodes live. Everything here watches this subtree. */
export { INSTANCES_PATH };

const PIPELINE_EVENT_FILTER: NodeEventFilter = {
  pathPrefix: INSTANCES_PATH,
  nodeTypes: ['directory'],
  eventTypes: ['created', 'updated', 'deleted'],
};

/**
 * The dashboard's data. One command, refetched when the pipeline subtree
 * changes rather than on a timer — idle costs nothing.
 */
export function usePipelineOverview() {
  const load = useCallback(() => execCommand<PipelineOverview>('pipeline-overview'), []);
  const { data, loading, error, bump, refetch } = useEventDrivenData(load);

  useNodeEvents(PIPELINE_EVENT_FILTER, bump);

  return { data, loading, error, refetch };
}

export function usePipelines() {
  const [data, setData] = useState<PipelineDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await execCommand<PipelineDef[]>('pipeline-list');
      setData(result || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

/**
 * One page of instances, newest first. `loadMore` appends the next page.
 *
 * Live updates are deliberately coarse here: a listing is a snapshot with a
 * cursor, so patching individual rows from events would leave the paging
 * inconsistent. Events only refresh the first page.
 */
export function usePipelineInstances(opts?: { pipeline?: string; status?: string; limit?: number }) {
  const { pipeline, status, limit = 100 } = opts ?? {};

  const command = useCallback((cursor?: string) => {
    let cmd = 'pipeline-instances';
    if (pipeline) cmd += ` ${shq(pipeline)}`;
    if (status) cmd += ` -s ${shq(status)}`;
    cmd += ` --limit ${limit}`;
    if (cursor) cmd += ` --after ${shq(cursor)}`;
    return cmd;
  }, [pipeline, status, limit]);

  const load = useCallback(() => execCommand<InstancePage>(command()), [command]);
  const { data, loading, error, bump, refetch } = useEventDrivenData(load, 3000);

  useNodeEvents(PIPELINE_EVENT_FILTER, bump);

  const [extra, setExtra] = useState<PipelineInstance[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // A refreshed first page invalidates everything paged in after it.
  const firstCursor = data?.nextCursor ?? null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current !== firstCursor) {
      seen.current = firstCursor;
      setExtra([]);
      setCursor(firstCursor);
    }
  }, [firstCursor]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await execCommand<InstancePage>(command(cursor));
      setExtra((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [command, cursor, loadingMore]);

  return {
    data: [...(data?.items ?? []), ...extra],
    loading,
    loadingMore,
    hasMore: cursor !== null,
    loadMore,
    error,
    refetch,
  };
}

/**
 * One instance's steps, patched live.
 *
 * Unlike the counts, a step row *can* be applied from an event: the event
 * carries that step's full attrs, so there is nothing to reconcile. The
 * initial `pipeline-status` is the only fetch.
 */
export function usePipelineStatus(pipeline: string | null, instanceId: string | null) {
  const ref = pipeline && instanceId ? `${pipeline}/${instanceId}` : null;

  const load = useCallback(async () => {
    if (!ref) return null;
    return await execCommand<PipelineStatus>(`pipeline-status ${shq(ref)}`);
  }, [ref]);

  const { data, loading, error, refetch } = useEventDrivenData(load, 1000);
  const [patched, setPatched] = useState<PipelineStatus | null>(null);

  useEffect(() => setPatched(data), [data]);

  const instancePath = ref ? `${INSTANCES_PATH}/${ref}` : null;

  useNodeEvents(
    { pathPrefix: instancePath ?? `${INSTANCES_PATH}/none`, nodeTypes: ['directory'], eventTypes: ['created', 'updated'] },
    useCallback((event) => {
      if (!instancePath) return;
      const attrs = event.node?.attrs as Record<string, unknown> | undefined;
      if (!attrs) return;

      setPatched((prev) => {
        if (!prev) return prev;

        if (event.path === instancePath && typeof attrs.status === 'string') {
          return { ...prev, status: attrs.status, completedAt: attrs.completedAt as number | undefined };
        }

        const stepPrefix = `${instancePath}/steps/`;
        if (!event.path.startsWith(stepPrefix)) return prev;
        const stepName = event.path.slice(stepPrefix.length);
        if (stepName.includes('/')) return prev;

        const steps = prev.steps.map((step) => step.stepName === stepName ? { ...step, ...(attrs as Partial<PipelineStep>) } : step);
        // A step that wasn't in the initial fetch (a rerun rebuilt them).
        if (!steps.some((step) => step.stepName === stepName)) return prev;
        return { ...prev, steps };
      });
    }, [instancePath]),
  );

  return { data: patched, loading, error, refetch };
}

/**
 * Instance actions (rerun / cancel / remove / prune). Ids must be qualified as
 * `<pipeline>/<id>` — a bare id is ambiguous, since an instance is named after
 * its trigger node and one file can be processed by several pipelines.
 */
export function usePipelineActions() {
  const rerun = useCallback((refs: string[]) => execCommand(`pipeline-rerun ${refs.map(shq).join(' ')}`), []);
  const cancel = useCallback(async (refs: string[]) => {
    // cancel refuses a finished instance; run per-id so one failure doesn't
    // abort the rest.
    await Promise.allSettled(refs.map((ref) => execCommand(`pipeline-cancel ${shq(ref)}`)));
  }, []);
  const remove = useCallback((refs: string[]) => execCommand(`pipeline-remove ${refs.map(shq).join(' ')} -f`), []);
  const restartStep = useCallback(
    (ref: string, step: string) => execCommand(`pipeline-step-restart ${shq(ref)} ${shq(step)}`),
    [],
  );
  const prune = useCallback((opts?: { pipeline?: string; status?: string; all?: boolean }) => {
    let cmd = 'pipeline-prune';
    if (opts?.pipeline) cmd += ` ${shq(opts.pipeline)}`;
    if (opts?.status) cmd += ` -s ${shq(opts.status)}`;
    if (opts?.all) cmd += ' --all';
    return execCommand(cmd);
  }, []);
  return { rerun, cancel, remove, restartStep, prune };
}
