/**
 * Bidirectional relations: a pair of softlinks under each node's
 * relations/ directory, each carrying attrs.relation = { label, peerLink }.
 * The relations-guard service removes the peer when one side is deleted.
 */

import { basename, dirname, join, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { RelationAttrs } from '../../../../lib/api/relation.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const RELATIONS_DIR = 'relations';

const relationLinkName = (label: string, targetPath: string): string => `${label}-${basename(targetPath)}`;

export const relate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['reverse'] });
  const [aArg, bArg, label] = flags._ as string[];

  if (!aArg || !bArg || !label) {
    await cmd.writeError('Usage: relate <a> <b> <label> [--reverse <label>]\n');
    return 1;
  }

  const a = resolve(cmd.cwd, aArg);
  const b = resolve(cmd.cwd, bArg);
  const reverseLabel = (flags.reverse as string | undefined) || label;

  try {
    await cmd.sys.vfs.get(cmd.access, a);
    await cmd.sys.vfs.get(cmd.access, b);

    const aLink = join(a, RELATIONS_DIR, relationLinkName(label, b));
    const bLink = join(b, RELATIONS_DIR, relationLinkName(reverseLabel, a));

    if (await cmd.sys.vfs.exists(cmd.access, aLink, { follow: false })) {
      await cmd.writeError(`relate: relation already exists: ${aLink}\n`);
      return 1;
    }

    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, a, RELATIONS_DIR);
    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, b, RELATIONS_DIR);

    await cmd.sys.vfs.create(cmd.access, NODE_TYPE_SOFTLINK, dirname(aLink), basename(aLink), {
      props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: b },
      attrs: { relation: { label, peerLink: bLink } },
    });
    await cmd.sys.vfs.create(cmd.access, NODE_TYPE_SOFTLINK, dirname(bLink), basename(bLink), {
      props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: a },
      attrs: { relation: { label: reverseLabel, peerLink: aLink } },
    });

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.writeLn(`Created bidirectional relation: ${a} <-${label}${reverseLabel !== label ? `/${reverseLabel}` : ''}-> ${b}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`relate: ${message}\n`);
    return 1;
  }
};

relate.spec = {
  name: 'relate',
  effect: 'write' as const,
  description: 'Create a bidirectional relation between two nodes',
  args: [
    { name: 'a', type: 'path' as const, description: 'first node' },
    { name: 'b', type: 'path' as const, description: 'second node' },
    { name: 'label', type: 'string' as const, description: 'relation label (both sides unless --reverse)' },
  ],
  flags: [
    { name: 'reverse', type: 'string' as const, description: 'label for the b -> a side (default: same as label)' },
  ],
};

export const unrelate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const [aArg, bArg, label] = flags._ as string[];

  if (!aArg) {
    await cmd.writeError('Usage: unrelate <link-path> | unrelate <a> <b> <label>\n');
    return 1;
  }

  const linkPath = bArg ? join(resolve(cmd.cwd, aArg), RELATIONS_DIR, relationLinkName(label, resolve(cmd.cwd, bArg))) : resolve(cmd.cwd, aArg);

  if (bArg && !label) {
    await cmd.writeError('Usage: unrelate <link-path> | unrelate <a> <b> <label>\n');
    return 1;
  }

  try {
    const node = await cmd.sys.vfs.get<RelationAttrs>(cmd.access, linkPath, { follow: false });
    const peerLink = node.attrs.relation?.peerLink;
    if (!peerLink) {
      await cmd.writeError(`unrelate: ${linkPath}: not a relation link\n`);
      return 1;
    }

    await cmd.sys.vfs.unlink(cmd.access, linkPath, dirname(linkPath), { readlink: true });
    try {
      await cmd.sys.vfs.unlink(cmd.access, peerLink, dirname(peerLink), { readlink: true });
    } catch {
      // The peer is gone already; the relations guard may have removed it first.
    }

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.writeLn(`Removed relation ${linkPath} (and peer)`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`unrelate: ${message}\n`);
    return 1;
  }
};

unrelate.spec = {
  name: 'unrelate',
  effect: 'write' as const,
  description: 'Remove a bidirectional relation (both sides)',
  args: [
    { name: 'a', type: 'path' as const, description: 'relation link path, or first node' },
    { name: 'b', type: 'path' as const, description: 'second node (with label)' },
    { name: 'label', type: 'string' as const, description: 'relation label' },
  ],
  flags: [],
};
