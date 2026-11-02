/**
 * Tracker links: the URL a phone or GPS tracker posts its fixes to without signing in,
 * `/tracker/<track node id>.<token>`. The token is kept in the track's child `.tracker`.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS } from '../access/mod.ts';
import { isToken } from '../token/mod.ts';
import type { Node, NodeVFS } from '../../vfs/mod.ts';
import { isTrackerTokenNode, type TrackerTokenAttrs } from '../../vfs/types/tracker-token.ts';

/** The track's child that holds its tracker token. */
export const TRACKER_TOKEN_NAME = '.tracker';

const TRACKER_PREFIX = '/tracker/';

/** A ULID, then the token. */
const TRACKER_PATTERN = /^([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9]+)$/;

/** The path of the tracker link for the track `trackId` and its token. */
export const trackerPath = (trackId: string, token: string): string => `${TRACKER_PREFIX}${trackId}.${token}`;

/** Whether `pathname` is a tracker link's. */
export const isTrackerPath = (pathname: string): boolean => pathname.startsWith(TRACKER_PREFIX);

/** The track id and token a tracker link carries; undefined for anything that cannot be one. */
export const parseTrackerPath = (pathname: string): { trackId: string; token: string } | undefined => {
  const match = TRACKER_PATTERN.exec(pathname.slice(TRACKER_PREFIX.length).replace(/\/+$/, ''));
  return match && isToken(match[2]) ? { trackId: match[1], token: match[2] } : undefined;
};

/** The tracker token of the track at `trackPath`, read as the administrator; undefined when it has none. */
export const readTrackerToken = async (vfs: NodeVFS, trackPath: string): Promise<Node<TrackerTokenAttrs> | undefined> => {
  const node = await vfs.get<TrackerTokenAttrs>(ADMIN_ACCESS, join(trackPath, TRACKER_TOKEN_NAME)).catch(() => undefined);
  return node && isTrackerTokenNode(node) ? node : undefined;
};
