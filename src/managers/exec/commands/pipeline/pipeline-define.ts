import { PIPELINES_PATH } from '../../../../lib/paths.ts';
import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { parsePipeline } from '../../../pipeline/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineDefine = async (cmd: Command): CmdReturn => {
  const yamlPath = cmd.args[0];

  if (!yamlPath) {
    await cmd.writeError('pipeline-define: missing yaml path\n');
    return 1;
  }

  let yamlContent: string;
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, yamlPath, { mode: 'r' });
    try {
      yamlContent = await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch {
    await cmd.writeError(`pipeline-define: cannot read ${yamlPath}\n`);
    return 1;
  }

  let def;
  try {
    def = parsePipeline(yamlContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pipeline-define: ${message}\n`);
    return 1;
  }

  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  const defsPath = join(pipelinesPath, 'definitions');

  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, dirname(pipelinesPath), basename(pipelinesPath));
  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, pipelinesPath, 'definitions');
  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, pipelinesPath, 'instances');

  // A definition is a link to its YAML.
  const linkPath = join(defsPath, def.name);
  if (await cmd.sys.vfs.exists(cmd.access, linkPath)) {
    if (!cmd.json) await cmd.write(`Pipeline '${def.name}' already defined, updating\n`);
    await cmd.sys.vfs.unlink(cmd.access, linkPath, defsPath, { readlink: true });
  }

  await cmd.execute(`ln -s ${yamlPath} ${linkPath}`);
  if (cmd.json) {
    await cmd.writeJSON({ ok: true, name: def.name });
  } else {
    await cmd.write(`Defined pipeline '${def.name}'\n`);
  }

  return 0;
};

pipelineDefine.spec = {
  name: 'pipeline-define',
  admin: true,
  effect: 'write' as const,
  description: 'Register a pipeline definition from a YAML file',
  args: [
    { name: 'path', type: 'path' as const, description: 'Path to pipeline YAML file' },
  ],
};
