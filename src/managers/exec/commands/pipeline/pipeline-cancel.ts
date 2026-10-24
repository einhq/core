import { cancelInstance, instancesRoot, resolveInstance } from './lib.ts';
import { isLiveInstance } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineCancel = async (cmd: Command): CmdReturn => {
  const instanceId = cmd.args[0];

  if (!instanceId) {
    await cmd.writeError('pipeline-cancel: missing instance id\n');
    return 1;
  }

  const found = await resolveInstance(cmd, instancesRoot(cmd), instanceId, 'pipeline-cancel');
  if (!found) return 1;

  if (!isLiveInstance(found.attrs.status)) {
    await cmd.writeError(`pipeline-cancel: instance is ${found.attrs.status}, not running\n`);
    return 1;
  }

  await cancelInstance(cmd, found.path);

  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  } else {
    await cmd.write(`Cancelled ${instanceId}\n`);
  }
  return 0;
};

pipelineCancel.spec = {
  name: 'pipeline-cancel',
  admin: true,
  effect: 'write' as const,
  description: 'Cancel a running pipeline',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID' },
  ],
};
