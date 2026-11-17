/**
 * stream-file — a recording or video for a screen EiN does not reach itself: one on the network of a
 * phone that reaches EiN over the internet, which the browser hands the file's address to.
 *
 * The making is the command the `CFG_FILE_STREAMER` setting names (the devices module's
 * `devices-nearby`), run with `start <path>`, `renew <id>` and `stop <id>`; core only asks it, so
 * "Show on" names no module. What it makes is kept while the caller renews it, and let go of
 * five minutes after the last time.
 */
import type { StreamedFile } from '../../../../lib/api/devices.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { readSettings } from '../../../../lib/config/read-settings.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const streamFile = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['renew', 'stop'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const path = flags._.length === 1 ? String(flags._[0]) : undefined;
  const id = flags.renew ?? flags.stop;
  const asked = [path, flags.renew, flags.stop].filter((each) => each !== undefined).length;
  if (asked !== 1 || (path !== undefined && !path.startsWith('/')) || (id !== undefined && !String(id))) {
    await cmd.writeError('usage: stream-file <path> | --renew <id> | --stop <id>\n');
    return 2;
  }

  // Read now rather than from this shell's environment: the Web UI's shell outlives a settings change.
  const streamer = (await readSettings(cmd, cmd.access, { user: false })).CFG_FILE_STREAMER?.trim();
  if (!streamer) {
    await cmd.writeError('stream-file: no command makes files for a screen near the browser here (CFG_FILE_STREAMER)\n');
    return 1;
  }
  const action = path !== undefined ? `start ${shq(path)}` : `${flags.renew !== undefined ? 'renew' : 'stop'} ${shq(String(id))}`;
  const run = await cmd.execute(`JSON_OUTPUT=1 ${streamer} ${action}`);
  if (run.code !== 0) {
    await cmd.writeError(`stream-file: ${run.stderr.trim().replace(/^[\w-]+: /, '') || `${streamer}: exit ${run.code}`}\n`);
    return run.code;
  }
  if (path === undefined) {
    if (cmd.json) await cmd.writeJSON({ ok: true });
    return 0;
  }

  const { id: made, url, type, title } = JSON.parse(run.stdout) as StreamedFile;
  if (cmd.json) await cmd.writeJSON({ id: made, url, type, title } satisfies StreamedFile);
  else await cmd.writeLn(`${made}  ${type}  ${url}`);
  return 0;
};

streamFile.spec = {
  name: 'stream-file',
  effect: 'read' as const,
  description: 'A recording or video for a screen near the browser to fetch, as the caller: by the command CFG_FILE_STREAMER names; renew it to keep it',
  args: [{ name: 'path', type: 'string', optional: true, description: 'The recording or video' }],
  flags: [
    { name: 'renew', type: 'string' as const, description: 'keep what an earlier stream-file made, by its id, five minutes more' },
    { name: 'stop', type: 'string' as const, description: 'let go of what an earlier stream-file made, by its id' },
  ],
  examples: ['stream-file /media/2024/boat.mp4', 'stream-file --renew near-3f2a9c0d1e4b5a6c'],
  returns: 'id (for --renew and --stop), url (a path read without signing in until it is let go of), type and title',
};
