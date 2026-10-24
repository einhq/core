/**
 * Relations guard (long-running service command)
 *
 * Referential integrity for links: watches deleted nodes and removes what
 * would otherwise dangle — the reciprocal link of a deleted relation softlink,
 * and the /tags/<label> links of a deleted labeled node.
 *
 * Removals are queued and run one at a time, off the handler, for the pool's
 * sake: a bulk delete would otherwise put one cleanup transaction per event in
 * flight against the same connections the deletes themselves are using.
 */

import { dirname } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { deferred } from '../../../../lib/async/deferred.ts';
import { createLogger } from '../../../logger/mod.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { type LabeledAttrs, TAGS_PATH } from './label.ts';
import type { RelationAttrs } from '../../../../lib/api/relation.ts';

const logger = createLogger('relations-guard');

export const relationsGuard = async (cmd: Command): CmdReturn => {
  if (!cmd.sys.vfs.subscribe) {
    await cmd.writeError('relations-guard: vfs does not support event subscriptions\n');
    return 1;
  }

  // Cleanup jobs, run one at a time — see the note at the top of the file.
  const queue: (() => Promise<void>)[] = [];
  let pumping: Promise<void> | undefined;

  const pump = async (): Promise<void> => {
    while (queue.length > 0) {
      try {
        await queue.shift()!();
      } catch (error) {
        // The link is already gone (unrelate removed both sides, a cascade beat
        // us, or an earlier event did) — that is the normal case, not a fault.
        logger.debug('Cleanup skipped', { error });
      }
    }
  };

  const defer = (job: () => Promise<void>): void => {
    queue.push(job);
    if (pumping) return;

    // A macrotask so the emitting unlink returns to its caller before the
    // cleanup starts competing with it for connections.
    pumping = new Promise<void>((resolve) => {
      setTimeout(async () => {
        try {
          await pump();
        } finally {
          pumping = undefined;
          resolve();
        }
      }, 0);
    });
  };

  const relationSub = await cmd.sys.vfs.subscribe<RelationAttrs>(
    () => ADMIN_ACCESS,
    (event) => {
      const peerLink = event.node.attrs?.relation?.peerLink;
      if (!peerLink) return;

      defer(async () => {
        // Only ever the other half of *this* pair. By the time the job runs the
        // path may hold something else — a relation recreated after the delete,
        // or a plain link — and removing that would be a bug, not integrity.
        const peer = await cmd.sys.vfs.get<RelationAttrs>(ADMIN_ACCESS, peerLink, { follow: false });
        if (peer.attrs.relation?.peerLink !== event.path) return;

        await cmd.sys.vfs.unlink(ADMIN_ACCESS, peerLink, dirname(peerLink), { readlink: true });
      });
    },
    { eventTypes: ['deleted'], nodeTypes: [NODE_TYPE_SOFTLINK] },
  );

  const labelSub = await cmd.sys.vfs.subscribe<LabeledAttrs>(
    () => ADMIN_ACCESS,
    (event) => {
      const labels = event.node.attrs?.labels;
      if (!Array.isArray(labels) || labels.length === 0) return;

      defer(async () => {
        for (const labelName of labels) {
          const tagDir = `${TAGS_PATH}/${labelName}`;
          try {
            const children = await cmd.sys.vfs.children(ADMIN_ACCESS, tagDir);
            for (const child of children) {
              if (child.node.props.softlink === event.path) {
                await cmd.sys.vfs.unlink(ADMIN_ACCESS, `${tagDir}/${child.name}`, tagDir, { readlink: true });
              }
            }
          } catch {
            // No such tag directory: nothing to clean.
          }
        }
      });
    },
    { eventTypes: ['deleted'] },
  );

  await cmd.write('Relations guard running\n');

  const done = deferred<void>();
  cmd.onInterrupt(() => {
    done.resolve();
  });

  await done;
  cmd.onInterrupt(null);

  await relationSub.unsubscribe();
  await labelSub.unsubscribe();

  // Nothing can enqueue once the subscriptions are gone, so this terminates.
  while (pumping) await pumping;

  await cmd.write('Relations guard stopped\n');
  return 0;
};

relationsGuard.spec = {
  name: 'relations-guard',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Remove reciprocal relation links when one side is deleted (long-running)',
};
