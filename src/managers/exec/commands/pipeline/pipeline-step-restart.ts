import { PIPELINES_PATH, POOLS_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { resolveInstance } from './lib.ts';
import { isLiveInstance, type PipelineInstanceAttrs, type PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * pipeline-step-restart — run one step of an instance again: a failed or skipped one, or a running
 * one that has hung, whose command is stopped first. The step goes back to `pending` with its
 * attempts at zero, and a finished instance is opened again.
 */
export const pipelineStepRestart = async (cmd: Command): CmdReturn => {
  const instanceId = cmd.args[0];
  const stepName = cmd.args[1];

  if (!instanceId) {
    await cmd.writeError('pipeline-step-restart: missing instance id\n');
    return 1;
  }
  if (!stepName) {
    await cmd.writeError('pipeline-step-restart: missing step name\n');
    return 1;
  }

  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  const instancesPath = join(pipelinesPath, 'instances');

  const found = await resolveInstance(cmd, instancesPath, instanceId, 'pipeline-step-restart');
  if (!found) return 1;

  const { path: instancePath } = found;
  const stepPath = join(instancePath, 'steps', stepName);

  let stepNode;
  try {
    stepNode = await cmd.sys.vfs.get<PipelineStepAttrs>(cmd.access, stepPath);
  } catch {
    await cmd.writeError(`pipeline-step-restart: step '${stepName}' not found\n`);
    return 1;
  }

  const { status, pool } = stepNode.attrs;
  if (status !== 'failed' && status !== 'skipped' && status !== 'running') {
    await cmd.writeError(`pipeline-step-restart: step is ${status}, expected failed, skipped or running\n`);
    return 1;
  }

  // A running step's command is hung up by whoever runs it: a pool worker when its job is
  // cancelled, which is done first so the job the step is pooled with next is a new one; the
  // engine, for a step it runs itself, when it sees the step set back below.
  if (status === 'running' && pool) {
    try {
      await cmd.sys.vfs.poolCancel(cmd.access, join(cmd.env.POOLS_PATH || POOLS_PATH, pool), { dedupKey: stepPath });
    } catch {
      // Pool or job already gone: nothing holds the step.
    }
  }

  await cmd.sys.vfs.update<PipelineStepAttrs>(cmd.access, stepPath, {
    attrs: {
      status: 'pending',
      attempts: 0,
      startedAt: undefined,
      outputAt: undefined,
      completedAt: undefined,
      exitCode: undefined,
      error: undefined,
    },
  });

  // A finished instance is opened again, so the engine advances it.
  if (!isLiveInstance(found.attrs.status)) {
    await cmd.sys.vfs.update<PipelineInstanceAttrs>(cmd.access, instancePath, {
      attrs: { status: 'running', completedAt: undefined },
    });
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  } else {
    await cmd.write(`Reset step '${stepName}' to pending\n`);
  }
  return 0;
};

pipelineStepRestart.spec = {
  name: 'pipeline-step-restart',
  admin: true,
  effect: 'write' as const,
  description: 'Run one pipeline step again: a failed or skipped one, or a running one, which is stopped first',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID' },
    { name: 'step', type: 'string' as const, description: 'Step name' },
  ],
};
