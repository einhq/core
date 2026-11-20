/**
 * stream-page — a page of EiN as live video, for a screen EiN does not reach itself: one on the
 * network of a phone that reaches EiN over the internet, which the browser hands the stream's
 * address to.
 *
 * The rendering is the command the `CFG_PAGE_STREAMER` setting names (the media service's
 * `page-stream start`); core only asks it, so "Show on" names no module. A page is a route, as the
 * address bar has it (`/dashboard-wall/Kitchen`, `/slideshow?q=sailboat&slideshow=screen`): a path whose
 * first folder is one of EiN's names a file, which is refused, as a screen's driver tells them apart.
 *
 * A page streamed so is controlled by the command the `CFG_PAGE_CONTROL` setting names (the media
 * service's `page-stream`), which says whose stream it may be: `stream-page --press <id> <key>...`
 * presses keys in it, `--state <id>` answers what it says it shows (`ScreenState`), and `--message
 * <id> <json>` hands it a message (`ScreenMessage`, for a slideshow). That is how a screen's controls step through a slideshow,
 * say what it shows and move in its video.
 */
import type { ScreenState, StreamedPage } from '../../../../lib/api/devices.ts';
import { readSettings } from '../../../../lib/config/read-settings.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const CONTROL_USAGE = 'usage: stream-page --press <id> <key>... | --state <id> | --message <id> <json>\n';

/** `--press`, `--state` and `--message`: the control command's `press`, `state` and `message`, as the caller. */
const control = async (cmd: Command, flag: string, id: string | undefined, rest: string[]): CmdReturn => {
  const verb = flag.slice(2);
  if (!id || (verb === 'press' && !rest.length) || (verb === 'state' && rest.length) || (verb === 'message' && rest.length !== 1)) {
    await cmd.writeError(CONTROL_USAGE);
    return 2;
  }
  if (verb === 'message') {
    const message = (() => {
      try {
        return JSON.parse(rest[0]) as unknown;
      } catch {
        return undefined;
      }
    })();
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      await cmd.writeError('stream-page: --message takes a JSON object, such as \'{"seek":80}\'\n');
      return 2;
    }
  }
  const controller = (await readSettings(cmd, cmd.access, { user: false })).CFG_PAGE_CONTROL?.trim();
  if (!controller) {
    await cmd.writeError('stream-page: no command controls a page here (CFG_PAGE_CONTROL)\n');
    return 1;
  }
  const run = await cmd.execute(`JSON_OUTPUT=1 ${controller} ${verb} ${shq(id)} ${rest.map(shq).join(' ')}`);
  if (run.code !== 0) {
    await cmd.writeError(`stream-page: ${controller} ${verb}: ${run.stderr.trim() || `exit ${run.code}`}\n`);
    return run.code;
  }
  if (verb === 'state') {
    const state = JSON.parse(run.stdout || 'null') as ScreenState | null;
    if (cmd.json) await cmd.writeJSON(state satisfies ScreenState | null);
    else await cmd.writeLn(state ? JSON.stringify(state) : 'the page says nothing of what it shows');
    return 0;
  }
  if (cmd.json) await cmd.writeJSON({ ok: true });
  return 0;
};

export const streamPage = async (cmd: Command): CmdReturn => {
  const flag = cmd.args[0];
  if (flag === '--press' || flag === '--state' || flag === '--message') return await control(cmd, flag, cmd.args[1], cmd.args.slice(2));
  const route = cmd.args[0];
  if (!route?.startsWith('/') || cmd.args.length > 1) {
    await cmd.writeError('usage: stream-page <route>\n');
    return 2;
  }

  const folder = `/${route.split('/')[1]?.split('?')[0] ?? ''}`;
  if (folder === '/' || await cmd.sys.vfs.get(cmd.access, folder).then(() => true, () => false)) {
    await cmd.writeError(`stream-page: ${route} names a file, not a page\n`);
    return 1;
  }

  // Read now rather than from this shell's environment: the Web UI's shell outlives a settings change.
  const streamer = (await readSettings(cmd, cmd.access, { user: false })).CFG_PAGE_STREAMER?.trim();
  if (!streamer) {
    await cmd.writeError('stream-page: no command renders pages here (CFG_PAGE_STREAMER)\n');
    return 1;
  }
  const run = await cmd.execute(`JSON_OUTPUT=1 ${streamer} ${shq(route)}`);
  if (run.code !== 0) {
    await cmd.writeError(`stream-page: ${streamer}: ${run.stderr.trim() || `exit ${run.code}`}\n`);
    return run.code;
  }
  const { id, path, remote, hls } = JSON.parse(run.stdout) as StreamedPage;
  if (!remote || !hls) {
    await cmd.writeError(`stream-page: ${streamer} gives no form for a screen near the browser (remote, hls)\n`);
    return 1;
  }

  if (cmd.json) await cmd.writeJSON({ id, path, remote, hls } satisfies StreamedPage);
  else await cmd.writeLn(`${id}  ${path}.mp4  ${path}.ts  ${remote}  ${hls}`);
  return 0;
};

streamPage.spec = {
  name: 'stream-page',
  effect: 'read' as const,
  description: 'A page of EiN as live video, as the caller sees it, for a screen near the browser: by the command CFG_PAGE_STREAMER names',
  args: [{
    name: 'route',
    type: 'string',
    description: "The page's route, such as /dashboard-wall/Kitchen; with --press, --state or --message, the stream's id and what follows",
  }],
  flags: [
    { name: 'press', type: 'bool' as const, writes: true, description: 'press keys in a page streamed so: --press <id> <key>..., by the command CFG_PAGE_CONTROL names' },
    { name: 'state', type: 'bool' as const, description: 'what a page streamed so says it shows: --state <id>' },
    { name: 'message', type: 'bool' as const, writes: true, description: 'hand a page streamed so a message: --message <id> \'{"seek":80}\'' },
  ],
  examples: [
    'stream-page /dashboard-wall/Kitchen',
    "stream-page '/slideshow?q=sailboat&slideshow=screen'",
    'stream-page --press page-3f2a9c41d07b5e18 ArrowRight',
    'stream-page --state page-3f2a9c41d07b5e18',
    'stream-page --message page-3f2a9c41d07b5e18 \'{"seek":80}\'',
  ],
  returns:
    "id: the stream's, for --press, --state and --message; path: its stream nodes <path>.mp4 and <path>.ts, the caller's; remote: the MP4 for a screen near a browser; hls: the live HLS playlist; those two without signing in, until nobody has read it for a while. --press, --message: ok. --state: what the page says it shows (title, path, kind, position, media with time, duration and paused), or null.",
};
