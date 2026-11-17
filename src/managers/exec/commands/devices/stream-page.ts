/**
 * stream-page — a page of EiN as live video, for a screen EiN does not reach itself: one on the
 * network of a phone that reaches EiN over the internet, which the browser hands the stream's
 * address to.
 *
 * The rendering is the command the `CFG_PAGE_STREAMER` setting names (the media service's
 * `page-stream start`); core only asks it, so "Show on" names no module. A page is a route, as the
 * address bar has it (`/dashboard-wall/Kitchen`, `/media?q=sailboat&slideshow=screen`): a path whose
 * first folder is one of EiN's names a file, which is refused, as a screen's driver tells them apart.
 */
import type { StreamedPage } from '../../../../lib/api/devices.ts';
import { readSettings } from '../../../../lib/config/read-settings.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const streamPage = async (cmd: Command): CmdReturn => {
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
  const { path, remote, hls } = JSON.parse(run.stdout) as StreamedPage;
  if (!remote || !hls) {
    await cmd.writeError(`stream-page: ${streamer} gives no form for a screen near the browser (remote, hls)\n`);
    return 1;
  }

  if (cmd.json) await cmd.writeJSON({ path, remote, hls } satisfies StreamedPage);
  else await cmd.writeLn(`${path}.mp4  ${path}.ts  ${remote}  ${hls}`);
  return 0;
};

streamPage.spec = {
  name: 'stream-page',
  effect: 'read' as const,
  description: 'A page of EiN as live video, as the caller sees it, for a screen near the browser: by the command CFG_PAGE_STREAMER names',
  args: [{ name: 'route', type: 'string', description: "The page's route, such as /dashboard-wall/Kitchen" }],
  examples: ['stream-page /dashboard-wall/Kitchen', "stream-page '/media?q=sailboat&slideshow=screen'"],
  returns:
    'path: read <path>.mp4 or <path>.ts; remote: the MP4 for a screen near a browser; hls: the live HLS playlist; all without signing in, until nobody has read it for a while.',
};
