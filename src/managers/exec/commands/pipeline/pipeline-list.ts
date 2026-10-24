import { PIPELINES_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import { parsePipeline } from '../../../pipeline/mod.ts';
import type { PipelineTrigger } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { PipelineSummary, PipelineTriggerSummary } from '../../../../lib/api/pipeline.ts';

/** `media.metadata.extracted` for a fact trigger, `updated:file` for a VFS one. */
const describeTrigger = (trigger: PipelineTrigger): string => trigger.on?.join(', ') ?? `${trigger.event}:${trigger.nodeType}`;
const describeTriggers = (triggers: PipelineTrigger[]): string => triggers.map(describeTrigger).join('; ');

export const pipelineList = async (cmd: Command): CmdReturn => {
  const color = colorer(!cmd.tty);
  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  const defsPath = join(pipelinesPath, 'definitions');

  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, defsPath);
  } catch {
    await cmd.write('No pipelines defined\n');
    return 0;
  }

  if (cmd.json) {
    const data: PipelineSummary[] = [];
    for (const entry of entries) {
      try {
        const yamlPath = join(defsPath, entry.name);
        const handle = await cmd.sys.vfs.open(cmd.access, yamlPath, { mode: 'r' });
        let yaml: string;
        try {
          yaml = await toText(handle.readable);
        } finally {
          await handle.close();
        }
        const def = parsePipeline(yaml);
        data.push({
          name: def.name,
          description: def.description || '',
          triggers: def.triggers.map(({ on, event, nodeType }) => ({ on, event, nodeType })),
          // The whole trigger, guards included, so the dashboard can say what gets skipped and why.
          triggerRules: def.triggers satisfies PipelineTriggerSummary[],
          // Fact-triggered pipelines only set `on`, so `event:nodeType` is no label for
          // them; this is the same string the CLI table shows.
          triggerLabel: describeTriggers(def.triggers),
          steps: Object.keys(def.steps),
          // Which pool kind each step is delegated to, so a caller can join a pipeline against
          // live worker state without sampling step nodes for it. Absent for an inline step.
          stepKinds: Object.fromEntries(
            Object.entries(def.steps).filter(([, step]) => step.kind).map(([name, step]) => [name, step.kind!]),
          ),
          options: def.options,
        });
      } catch {
        // Complete even when broken, so a reader can list it without special-casing a half entry.
        data.push({ name: entry.name, description: '', triggers: [], steps: [], error: true });
      }
    }
    await cmd.writeJSON(data);
    return 0;
  }

  if (entries.length === 0) {
    await cmd.write('No pipelines defined\n');
    return 0;
  }

  const table = new Table({
    header: true,
    columns: [
      { name: 'NAME', align: 'left' },
      { name: 'TRIGGER', align: 'left' },
      { name: 'STEPS', align: 'right' },
      { name: 'DESCRIPTION', align: 'left' },
    ],
  });

  for (const entry of entries) {
    try {
      const yamlPath = join(defsPath, entry.name);
      const handle = await cmd.sys.vfs.open(cmd.access, yamlPath, { mode: 'r' });
      let yaml: string;
      try {
        yaml = await toText(handle.readable);
      } finally {
        await handle.close();
      }

      const def = parsePipeline(yaml);
      table.addRow({
        NAME: color('cyan', def.name),
        TRIGGER: describeTriggers(def.triggers),
        STEPS: String(Object.keys(def.steps).length),
        DESCRIPTION: def.description || '',
      });
    } catch {
      table.addRow({
        NAME: color('red', entry.name),
        TRIGGER: '?',
        STEPS: '?',
        DESCRIPTION: 'error reading definition',
      });
    }
  }

  await cmd.write(table.render());
  return 0;
};

pipelineList.spec = {
  name: 'pipeline-list',
  effect: 'read' as const,
  description: 'List pipeline definitions',
};
