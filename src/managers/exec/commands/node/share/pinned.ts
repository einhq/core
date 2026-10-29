import { ACCESS_PINNED_ATTR } from '../../../../../lib/access/mod.ts';
import type { Access } from '../../../../../lib/access/mod.ts';
import type { NodePath, NodeQueryCursor, NodeQueryEntry, NodeVFS } from '../../../../../vfs/mod.ts';

/** Pinned nodes read per query page; few nodes are pinned, so most answers take one. */
const PINNED_PAGE = 500;

/**
 * The nodes below `path` that keep their own sharing (`share-set --pin`) and `access` can read, in
 * no set order: found through the index on the pin rather than by walking the subtree, since a pin
 * is rare and a subtree is not.
 */
export async function* pinnedBelow(vfs: NodeVFS, access: Access, path: NodePath): AsyncGenerator<NodeQueryEntry> {
  const prefix = path === '/' ? '/' : `${path}/`;
  let after: NodeQueryCursor | undefined;

  for (;;) {
    const page = await vfs.query(access, {
      where: [{ ref: ACCESS_PINNED_ATTR, op: 'eq', value: true }],
      ...(after ? { after } : {}),
      limit: PINNED_PAGE,
    });

    for (const hit of page) {
      if (hit.absPath.startsWith(prefix)) yield hit;
    }

    if (page.length < PINNED_PAGE) return;
    const last = page[page.length - 1];
    after = { value: last.sortValue, id: last.id };
  }
}
