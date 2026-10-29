import { PIPELINE_QUEUE_PATH, PIPELINES_PATH, POOLS_PATH } from '../../../../lib/paths.ts';
import { deferred } from '../../../../lib/async/deferred.ts';
import { EVENTS_ROUTING_KEY, PIPELINE_EVENTS_NODE_PATH } from '../../../../lib/events/mod.ts';
import { PipelineEngine } from '../../../pipeline/engine.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineEngine = async (cmd: Command): CmdReturn => {
  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  const queuePath = cmd.env.PIPELINE_QUEUE_PATH || PIPELINE_QUEUE_PATH;
  const maxConcurrent = Number(cmd.env.CFG_PIPELINE_MAX_CONCURRENT) || 4;
  const triggerConcurrency = Number(cmd.env.CFG_PIPELINE_TRIGGER_CONCURRENCY) || 4;
  const consumeConcurrency = Number(cmd.env.CFG_PIPELINE_CONSUME_CONCURRENCY) || 4;
  const entryAdmissionPercent = Number(cmd.env.CFG_PIPELINE_ENTRY_ADMISSION_PERCENT) || 0;
  const maxAdmittedSteps = Number(cmd.env.CFG_PIPELINE_MAX_ADMITTED_STEPS) || maxConcurrent * 25;
  // Deliberately not derived from maxConcurrent: what bounds this is the O(open) re-advance
  // sweep, not how many steps run at once. See PipelineEngine's maxOpenInstances.
  const maxOpenInstances = Number(cmd.env.CFG_PIPELINE_MAX_OPEN_INSTANCES) || undefined;
  const stuckSweepMs = Number(cmd.env.CFG_PIPELINE_STUCK_SWEEP_MS) || undefined;
  // Always-bound keys. The engine adds a VFS key per `event:`-form definition on
  // top of these, so there is normally nothing to configure here.
  const routingKeys = (cmd.env.PIPELINE_ROUTING_KEYS || EVENTS_ROUTING_KEY)
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const engine = new PipelineEngine(
    cmd.sys.vfs,
    cmd.opts.tty,
    pipelinesPath,
    queuePath,
    routingKeys,
    maxConcurrent,
    PIPELINE_EVENTS_NODE_PATH,
    cmd.env.POOLS_PATH || POOLS_PATH,
    triggerConcurrency,
    consumeConcurrency,
    maxAdmittedSteps,
    maxOpenInstances,
    stuckSweepMs,
    entryAdmissionPercent,
  );

  // Wait for interrupt (SIGINT/SIGTERM/SIGHUP all resolve this via onInterrupt).
  // requestStop() flips the engine's cancel flags synchronously so an in-progress
  // start()/recover() (which can run for seconds draining a backlog) unwinds now,
  // letting the command exit within the service's graceful-stop window instead of
  // being force-torn-down mid-startup. Full cleanup runs in the finally below.
  const done = deferred<void>();
  cmd.onInterrupt(() => {
    engine.requestStop();
    done.resolve();
  });

  // engine.start() launches a detached consumeLoop; if any later step throws
  // (cmd.write hitting a torn-down fd during a service restart, say), the loop
  // must still be stopped, or it is orphaned and keeps running runAndCapture
  // against a dead shell.
  try {
    await engine.start();
    await cmd.write('Pipeline engine running\n');
    await done;
  } catch (error) {
    // start() refuses when a peer is already on this queue. That is a
    // configuration mistake, not a crash, so report it on stderr — which for a
    // service is its log — instead of exiting 255 with the reason buried in the
    // command state.
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pipeline-engine: ${message}\n`).catch(() => {});
    return 1;
  } finally {
    cmd.onInterrupt(null);
    await engine.stop();
  }

  await cmd.write('Pipeline engine stopped\n').catch(() => {});
  return 0;
};

pipelineEngine.spec = {
  name: 'pipeline-engine',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Run the pipeline engine (long-running)',
};
