/**
 * track-token — the link a phone or GPS tracker posts a track's fixes to without signing in.
 *
 *   track-token <track>          the link, or that there is none
 *   track-token <track> --new    make one, in place of any before it
 *   track-token <track> --off    turn it off
 *
 * The link is `/tracker/<track id>.<token>`; whatever posts to it appends as the track's owner. The
 * token is kept in the track's child `.tracker`, the administrator's and mode 0600, so the link can
 * be shown again, to whoever may change the track.
 */

import { join, resolve } from '@std/path';
import { ADMIN_ACCESS, verifyAccess } from '../../../../lib/access/mod.ts';
import type { TrackToken } from '../../../../lib/api/track.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { newToken } from '../../../../lib/token/mod.ts';
import { readTrackerToken, TRACKER_TOKEN_NAME, trackerPath } from '../../../../lib/track/tracker.ts';
import { NODE_TYPE_TRACKER_TOKEN, type TrackerTokenAttrs } from '../../../../vfs/types/tracker-token.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const USAGE = 'Usage: track-token <track> [--new|--off]';

export const trackToken = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['new', 'off'] });
  const fail = async (message: string): Promise<number> => {
    await cmd.writeError(`track-token: ${message}\n`);
    return 1;
  };

  const target = flags._[0] as string | undefined;
  if (!target) return await fail(USAGE);
  if (flags.new && flags.off) return await fail('--new and --off do not go together');

  try {
    const path = resolve(cmd.cwd, target);
    const track = await cmd.sys.vfs.get(cmd.access, path);
    if (track.type !== 'track') return await fail(`${path}: not a track`);
    if (!verifyAccess(cmd.access, track.props, 'w')) return await fail(`${path}: only someone who may change the track can see or change its tracker link`);

    const tokenPath = join(path, TRACKER_TOKEN_NAME);
    let record = await readTrackerToken(cmd.sys.vfs, path);

    if ((flags.new || flags.off) && record) {
      await cmd.sys.vfs.unlink(ADMIN_ACCESS, tokenPath, path);
      record = undefined;
    }
    if (flags.new) {
      const attrs: TrackerTokenAttrs = { token: newToken(), createdBy: cmd.access.uid, createdAt: Date.now() };
      record = await cmd.sys.vfs.create<TrackerTokenAttrs>(ADMIN_ACCESS, NODE_TYPE_TRACKER_TOKEN, path, TRACKER_TOKEN_NAME, { props: { mode: 0o600 }, attrs });
    }

    const answer: TrackToken = record
      ? { track: path, enabled: true, path: trackerPath(track.id, record.attrs.token), createdAt: record.attrs.createdAt }
      : { track: path, enabled: false };

    if (cmd.json) await cmd.writeJSON(answer satisfies TrackToken);
    else await cmd.writeLn(answer.path ?? `${path} takes no tracker posts`);
    return 0;
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
};

trackToken.spec = {
  name: 'track-token',
  effect: 'read' as const,
  description: "Show, make or turn off the link a phone or GPS tracker posts a track's fixes to without signing in",
  args: [
    { name: 'track', type: 'path' as const, description: 'the track node' },
  ],
  flags: [
    { name: 'new', writes: true, type: 'bool' as const, description: 'make a new link; the one before it stops working' },
    { name: 'off', writes: true, type: 'bool' as const, description: 'turn the link off' },
  ],
  examples: ['track-token /archive/devices/sailboat/position/history', 'track-token /archive/devices/sailboat/position/history --new'],
  returns: 'TrackToken: whether the track takes tracker posts, and the path of its link.',
};
