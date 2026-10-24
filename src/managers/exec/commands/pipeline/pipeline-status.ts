import { join } from '@std/path';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import { instancesRoot, resolveInstance } from './lib.ts';
import type { PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { PipelineInstanceStatus, PipelineStepStatus } from '../../../../lib/api/pipeline.ts';

export const pipelineStatus = async (cmd: Command): CmdReturn => {
  const instanceId = cmd.args[0];

  if (!instanceId) {
    await cmd.writeError('pipeline-status: missing instance id\n');
    return 1;
  }

  const color = colorer(!cmd.tty);

  const found = await resolveInstance(cmd, instancesRoot(cmd), instanceId, 'pipeline-status');
  if (!found) return 1;
  const { path: instancePath, attrs: instanceAttrs } = found;

  if (cmd.json) {
    const stepsPath = join(instancePath, 'steps');
    let stepsData: PipelineStepStatus[] = [];
    try {
      const steps = await cmd.sys.vfs.children<PipelineStepAttrs>(cmd.access, stepsPath);
      stepsData = steps.map((s) => ({
        stepName: s.node.attrs.stepName,
        status: s.node.attrs.status,
        dependsOn: s.node.attrs.dependsOn,
        command: s.node.attrs.command,
        condition: s.node.attrs.condition,
        // Which pool a 'waiting' step is parked on — without it a
        // caller can see that a step is waiting but not on what.
        pool: s.node.attrs.pool,
        kind: s.node.attrs.kind,
        attempts: s.node.attrs.attempts,
        maxAttempts: s.node.attrs.maxAttempts,
        startedAt: s.node.attrs.startedAt,
        outputAt: s.node.attrs.outputAt,
        waitingSince: s.node.attrs.waitingSince,
        completedAt: s.node.attrs.completedAt,
        exitCode: s.node.attrs.exitCode,
        error: s.node.attrs.error,
      }));
    } catch { /* no steps */ }

    await cmd.writeJSON(
      {
        id: instanceId,
        pipelineName: instanceAttrs.pipelineName,
        status: instanceAttrs.status,
        triggerPath: instanceAttrs.triggerPath,
        triggerEvent: instanceAttrs.triggerEvent,
        vars: instanceAttrs.vars,
        startedAt: instanceAttrs.startedAt,
        completedAt: instanceAttrs.completedAt,
        steps: stepsData,
      } satisfies PipelineInstanceStatus,
    );
    return 0;
  }

  const statusColor = getStatusColor(instanceAttrs.status);
  await cmd.write(`Pipeline: ${color('cyan', instanceAttrs.pipelineName)}\n`);
  await cmd.write(`Instance: ${instanceId}\n`);
  await cmd.write(`Status:   ${color(statusColor, instanceAttrs.status)}\n`);
  await cmd.write(`Path:     ${instanceAttrs.triggerPath}\n`);
  await cmd.write(`Started:  ${new Date(instanceAttrs.startedAt).toISOString()}\n`);
  // Only the ones actually set: a wall of empty defaults hides the one that was
  // overridden, which is the whole reason to look.
  const setVars = Object.entries(instanceAttrs.vars ?? {}).filter(([, value]) => value !== '');
  if (setVars.length > 0) {
    await cmd.write(`Vars:     ${setVars.map(([key, value]) => `${key}=${value}`).join(' ')}\n`);
  }
  if (instanceAttrs.completedAt) {
    await cmd.write(`Completed: ${new Date(instanceAttrs.completedAt).toISOString()}\n`);
  }
  await cmd.write('\n');

  const stepsPath = join(instancePath, 'steps');
  let steps;
  try {
    steps = await cmd.sys.vfs.children<PipelineStepAttrs>(cmd.access, stepsPath);
  } catch {
    await cmd.write('No steps\n');
    return 0;
  }

  const table = new Table({
    header: true,
    columns: [
      { name: 'STEP', align: 'left' },
      { name: 'STATUS', align: 'left' },
      { name: 'DEPENDS', align: 'left' },
      { name: 'COMMAND', align: 'left' },
    ],
  });

  for (const step of steps) {
    const attrs = step.node.attrs;
    const stepColor = getStatusColor(attrs.status);
    table.addRow({
      STEP: attrs.stepName,
      STATUS: color(stepColor, attrs.status),
      DEPENDS: attrs.dependsOn?.join(', ') || '-',
      COMMAND: attrs.command,
    });
  }

  await cmd.write(table.render());
  return 0;
};

function getStatusColor(status: string): 'green' | 'blue' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'blue';
    case 'waiting':
    case 'queued':
      return 'yellow';
    case 'failed':
    case 'cancelled':
      return 'red';
    default:
      return 'gray';
  }
}

pipelineStatus.spec = {
  name: 'pipeline-status',
  effect: 'read' as const,
  description: 'Show pipeline instance status',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID' },
  ],
};
