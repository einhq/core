import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { PoolThroughput } from '@ein/api';
import type { PipelineDef } from '@ein/ui/hooks';
import { formatDuration } from '../../lib/format.ts';

type Props = {
  pools: PoolThroughput[];
  definitions: PipelineDef[];
};

/**
 * Pool kinds with queued work that no running worker will ever claim.
 *
 * Every other alarm on this page is about work that ran and misbehaved. This is the one about
 * work that will never run: a kind renamed under its queued jobs, a worker service that died,
 * a `--kind` dropped from a start script, a typo in a definition. From the pool's side nothing
 * has gone wrong — the jobs are simply `ready`, growing at the arrival rate.
 *
 * Named by the pipelines that feed the kind, from the definitions. When none does, the jobs
 * belong to open instances whose step no definition queues under this kind any more. The engine
 * queues a cancelled job of an open instance again, under the kind its definition names now: so
 * `pool cancel` moves the jobs of a step given another kind, and those of a pipeline no longer
 * defined come back as they were until `pipeline prune` retires it, instances and jobs together.
 */
export function UnservableKinds({ pools, definitions }: Props) {
  const entries = pools.flatMap((pool) =>
    (pool.kinds ?? [])
      .filter((kind) => kind.unservableSince !== undefined)
      .map((kind) => ({ pool: pool.name, path: pool.path, kind: kind.kind, ready: kind.ready, since: kind.unservableSince! }))
  );
  if (entries.length === 0) return null;

  const feeders = (kind: string) => definitions.filter((def) => Object.values(def.stepKinds ?? {}).includes(kind)).map((def) => def.name);

  return (
    <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />} title='Work that nothing will run'>
      <Stack gap={4}>
        {entries.map((entry) => {
          const fed = feeders(entry.kind);
          return (
            <Text size='sm' key={`${entry.pool}/${entry.kind}`}>
              <Text span ff='monospace'>{entry.kind}</Text> in pool <Text span ff='monospace'>{entry.pool}</Text>: {entry.ready.toLocaleString()}{' '}
              jobs ready and no running worker offers this kind (for {formatDuration(Date.now() - entry.since)}). {fed.length > 0
                ? (
                  <>
                    Queued by {fed.map((name, index) => (
                      <span key={name}>
                        {index > 0 && ', '}
                        <Text span ff='monospace'>{name}</Text>
                      </span>
                    ))}.
                  </>
                )
                : (
                  <>
                    No defined pipeline queues this kind any more. If a pipeline now queues this step under another kind,{' '}
                    <Text span ff='monospace'>pool cancel {entry.path} --kind {entry.kind}</Text>{' '}
                    and the jobs are queued again under that kind; if the pipeline is no longer defined, <Text span ff='monospace'>pipeline prune</Text>{' '}
                    removes its instances and their jobs once it has been gone for ten minutes.
                  </>
                )}
            </Text>
          );
        })}
      </Stack>
    </Alert>
  );
}
