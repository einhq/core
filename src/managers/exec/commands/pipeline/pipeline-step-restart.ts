import { PIPELINES_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { resolveInstance } from './lib.ts';
import { isLiveInstance, type PipelineInstanceAttrs, type PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

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

  if (stepNode.attrs.status !== 'failed' && stepNode.attrs.status !== 'skipped') {
    await cmd.writeError(`pipeline-step-restart: step is ${stepNode.attrs.status}, expected failed or skipped\n`);
    return 1;
  }

  await cmd.sys.vfs.update<PipelineStepAttrs>(cmd.access, stepPath, {
    attrs: {
      status: 'pending',
      attempts: 0,
      startedAt: undefined,
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
  description: 'Restart a single pipeline step',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID' },
    { name: 'step', type: 'string' as const, description: 'Step name' },
  ],
};
