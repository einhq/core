import { join } from '@std/path';
import { instancesRoot, resolveInstance } from './lib.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineRestart = async (cmd: Command): CmdReturn => {
  const instanceId = cmd.args[0];

  if (!instanceId) {
    await cmd.writeError('pipeline-restart: missing instance id\n');
    return 1;
  }

  const found = await resolveInstance(cmd, instancesRoot(cmd), instanceId, 'pipeline-restart');
  if (!found) return 1;

  const { path: instancePath, attrs } = found;

  if (attrs.status !== 'failed' && attrs.status !== 'cancelled') {
    await cmd.writeError(`pipeline-restart: instance is ${attrs.status}, expected failed or cancelled\n`);
    return 1;
  }

  const stepsPath = join(instancePath, 'steps');
  let resetCount = 0;
  try {
    const steps = await cmd.sys.vfs.children<PipelineStepAttrs>(cmd.access, stepsPath);
    for (const step of steps) {
      if (step.node.attrs.status === 'failed') {
        await cmd.sys.vfs.update<PipelineStepAttrs>(cmd.access, join(stepsPath, step.name), {
          attrs: {
            status: 'pending',
            attempts: 0,
            startedAt: undefined,
            completedAt: undefined,
            exitCode: undefined,
            error: undefined,
          },
        });
        resetCount++;
      }
    }
  } catch {
    await cmd.writeError('pipeline-restart: cannot read steps\n');
    return 1;
  }

  await cmd.sys.vfs.update<PipelineInstanceAttrs>(cmd.access, instancePath, {
    attrs: { status: 'queued', completedAt: undefined, executingSince: undefined },
  });

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, reset: resetCount });
  } else {
    await cmd.write(`Restarted ${instanceId}, reset ${resetCount} failed step(s)\n`);
  }
  return 0;
};

pipelineRestart.spec = {
  name: 'pipeline-restart',
  admin: true,
  effect: 'write' as const,
  description: 'Restart a failed pipeline (re-queue failed steps)',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID' },
  ],
};
