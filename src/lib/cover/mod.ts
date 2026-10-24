/**
 * A node's cover: the `coverPhoto` softlink child (`COVER_LINK_NAME`, `@ein/paths`).
 *
 * Albums, people, locations and devices all carry one.
 */

import type { Access } from '../access/types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { COVER_LINK_NAME } from '../paths.ts';

export { COVER_LINK_NAME };

/** Where a node's cover link points, or undefined when it has none. The target may no longer exist. */
export const readCoverTarget = async (vfs: NodeVFS, access: Access, ownerPath: string): Promise<string | undefined> => {
  try {
    const link = await vfs.get(access, `${ownerPath}/${COVER_LINK_NAME}`, { readlink: true });
    return typeof link.props.softlink === 'string' ? link.props.softlink : undefined;
  } catch {
    return undefined;
  }
};

export type SetCoverOptions = {
  /**
   * Who owns the link. Default: the caller. Only an administrator may name another user. Whoever
   * may write the node may replace its cover, whoever owns the link.
   */
  uid?: number;
  gid?: number;
  /** Attrs on the link itself — a sweep marks a cover it picked (`autoCover`), so it may pick again. */
  attrs?: Record<string, unknown>;
};

/** Point a node's cover at `target`, replacing any cover it had. */
export const setCover = async (vfs: NodeVFS, access: Access, ownerPath: string, target: string, opts: SetCoverOptions = {}): Promise<void> => {
  const linkPath = `${ownerPath}/${COVER_LINK_NAME}`;
  if (await vfs.exists(access, linkPath, { follow: false })) {
    await vfs.unlink(access, linkPath, ownerPath, { follow: false });
  }
  await vfs.create(access, 'softlink', ownerPath, COVER_LINK_NAME, {
    props: { uid: opts.uid ?? access.uid, gid: opts.gid ?? access.gid, mode: 0o777, softlink: target },
    ...(opts.attrs ? { attrs: opts.attrs } : {}),
  });
};
