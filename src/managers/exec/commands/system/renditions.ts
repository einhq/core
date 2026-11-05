/**
 * renditions — the rendition table, `/etc/renditions.yaml`: the renditions made of every picture,
 * video and recording, by role, and the file each one is. The shell's pages read it as they load.
 * What the file gets wrong is left out of the answer and said on stderr.
 */

import { audioFileName, imageFileName, type RenditionTable, storyboardFileName, videoFileName } from '../../../../lib/api/renditions.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { readRenditionTable } from '../../../../lib/media/renditions.ts';
import { RENDITIONS_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** One line per role: its section, its name, its file and what it is. */
const lines = (table: RenditionTable): string[][] => [
  ...Object.entries(table.image).map(([role, r]) => ['image', role, imageFileName(r), `${r.fit} ${r.width}x${r.height}, quality ${r.quality}, for ${r.kinds.join(' ')}`]),
  ...Object.entries(table.video).map(([role, r]) => [
    'video',
    role,
    videoFileName(r),
    [`crf ${r.crf}`, `preset ${r.preset}`, ...(r.seconds ? [`${r.seconds} s from ${r.start ?? 0} s`] : []), r.mute ? 'no sound' : `sound ${r.audioBitrate ?? 'as the source'}`]
      .join(', '),
  ]),
  ...Object.entries(table.audio).map(([role, r]) => ['audio', role, audioFileName(r), `at most ${r.bitrate} and ${r.sampleRate} Hz`]),
  ...(table.storyboard
    ? [[
      'storyboard',
      '',
      storyboardFileName(table.storyboard),
      `tiles of ${table.storyboard.tile}, ${table.storyboard.columns} columns, at most ${table.storyboard.maxTiles}, ${table.storyboard.minInterval} s apart or more`,
    ]]
    : []),
];

export const renditions = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  let read;
  try {
    read = await readRenditionTable(cmd.sys.vfs);
  } catch (error) {
    await cmd.writeError(`renditions: ${RENDITIONS_PATH}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const warning of read.warnings) await cmd.writeError(`renditions: ${RENDITIONS_PATH}: ${warning}, left out\n`);

  if (cmd.json) {
    await cmd.writeJSON(read.table satisfies RenditionTable);
    return 0;
  }
  const rows = lines(read.table);
  if (rows.length === 0) {
    await cmd.writeLn(`No renditions: ${RENDITIONS_PATH} names none.`);
    return 0;
  }
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) await cmd.writeLn(row.map((cell, column) => column < 3 ? cell.padEnd(widths[column]) : cell).join('  '));
  return 0;
};

renditions.spec = {
  name: 'renditions',
  effect: 'read' as const,
  description: 'The renditions made of every picture, video and recording, by role, from /etc/renditions.yaml',
  args: [],
  flags: [],
  examples: ['renditions', 'JSON_OUTPUT=1 renditions'],
  returns: 'each role: its section (image, video, audio, storyboard), its name, its file and its settings; in JSON the table by section and role.',
};
