/**
 * Labels/tags: attrs.labels (string[]) on the node is the source of truth for
 * search; <tags>/<label>/ holds softlinks to labeled nodes for browsing. The
 * relations-guard service removes tag links when a labeled node is deleted;
 * `label prune` sweeps dangling links manually.
 */

import { basename, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

import { TAGS_ROOT as TAGS_PATH } from '../../../../lib/paths.ts';
import type { LabelEntry } from '../../../../lib/api/mod.ts';
export { TAGS_PATH };

export type LabeledAttrs = {
  labels?: string[];
};

const USAGE = 'Usage: label <add|remove|list|prune> [<path>] [<label>...]';

const validLabel = (label: string): boolean => /^[^/\s]+$/.test(label);

/** The label's directory under the tags root, which core declares as a root and `mod setup` creates. */
const ensureTagDir = async (cmd: Command, label: string): Promise<string> => {
  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, TAGS_PATH, label);
  return `${TAGS_PATH}/${label}`;
};

const findTagLink = async (cmd: Command, tagDir: string, target: string): Promise<string | undefined> => {
  try {
    const children = await cmd.sys.vfs.children(cmd.access, tagDir);
    const child = children.find((c) => c.node.props.softlink === target);
    return child ? `${tagDir}/${child.name}` : undefined;
  } catch {
    return undefined;
  }
};

const labelAdd = async (cmd: Command, path: string, labels: string[]): Promise<number> => {
  const node = await cmd.sys.vfs.get<LabeledAttrs>(cmd.access, path);
  const current = Array.isArray(node.attrs.labels) ? node.attrs.labels : [];

  for (const label of labels) {
    if (!validLabel(label)) {
      await cmd.writeError(`label: invalid label '${label}'\n`);
      return 1;
    }
  }

  const merged = [...current, ...labels.filter((l) => !current.includes(l))];
  await cmd.sys.vfs.update(cmd.access, path, { attrs: { labels: merged } });

  for (const label of labels) {
    const tagDir = await ensureTagDir(cmd, label);
    if (await findTagLink(cmd, tagDir, path)) continue;

    const children = await cmd.sys.vfs.children(cmd.access, tagDir);
    const usedNames = new Set(children.map((c) => c.name));
    let name = basename(path);
    for (let i = 2; usedNames.has(name); i++) {
      name = `${basename(path)}-${i}`;
    }
    await cmd.sys.vfs.create(cmd.access, NODE_TYPE_SOFTLINK, tagDir, name, {
      props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: path },
    });
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, labels: merged });
  } else {
    await cmd.writeLn(`Labeled ${path}: ${merged.join(', ')}`);
  }
  return 0;
};

const labelRemove = async (cmd: Command, path: string, labels: string[]): Promise<number> => {
  const node = await cmd.sys.vfs.get<LabeledAttrs>(cmd.access, path);
  const current = Array.isArray(node.attrs.labels) ? node.attrs.labels : [];
  const remaining = current.filter((l) => !labels.includes(l));
  await cmd.sys.vfs.update(cmd.access, path, { attrs: { labels: remaining } });

  for (const label of labels) {
    const link = await findTagLink(cmd, `${TAGS_PATH}/${label}`, path);
    if (link) {
      await cmd.sys.vfs.unlink(cmd.access, link, `${TAGS_PATH}/${label}`, { readlink: true });
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, labels: remaining });
  } else {
    await cmd.writeLn(`Labels on ${path}: ${remaining.length ? remaining.join(', ') : '-'}`);
  }
  return 0;
};

const labelList = async (cmd: Command, path?: string): Promise<number> => {
  if (path) {
    const node = await cmd.sys.vfs.get<LabeledAttrs>(cmd.access, path);
    const labels = Array.isArray(node.attrs.labels) ? node.attrs.labels : [];
    if (cmd.json) {
      await cmd.writeJSON(labels);
    } else {
      for (const label of labels) await cmd.writeLn(label);
    }
    return 0;
  }

  // Every label in use: each child of /tags with its member count. A label whose last link went —
  // removed, or dropped with the node it pointed at — keeps its directory but is no longer a label.
  let entries: LabelEntry[] = [];
  try {
    const children = await cmd.sys.vfs.children(cmd.access, TAGS_PATH);
    entries = children.filter((c) => c.childCount > 0).map((c) => ({ label: c.name, count: c.childCount }));
  } catch {
    // No /tags yet: no labels.
  }

  if (cmd.json) {
    await cmd.writeJSON(entries);
  } else {
    for (const e of entries) await cmd.writeLn(`${e.label} (${e.count})`);
  }
  return 0;
};

const labelPrune = async (cmd: Command): Promise<number> => {
  let pruned = 0;
  try {
    const tagDirs = await cmd.sys.vfs.children(cmd.access, TAGS_PATH);
    for (const dir of tagDirs) {
      const tagDir = `${TAGS_PATH}/${dir.name}`;
      const links = await cmd.sys.vfs.children(cmd.access, tagDir);
      for (const link of links) {
        const target = link.node.props.softlink;
        if (!target) continue;
        if (!await cmd.sys.vfs.exists(cmd.access, target)) {
          await cmd.sys.vfs.unlink(cmd.access, `${tagDir}/${link.name}`, tagDir, { readlink: true });
          pruned++;
        }
      }
    }
  } catch {
    // No /tags yet: nothing to prune.
  }
  if (cmd.json) {
    await cmd.writeJSON({ ok: true, pruned });
  } else {
    await cmd.writeLn(`Pruned ${pruned} dangling tag link(s)`);
  }
  return 0;
};

export const label = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const [sub, pathArg, ...labels] = flags._;

  try {
    switch (sub) {
      case 'add':
      case 'remove': {
        if (!pathArg || labels.length === 0) {
          await cmd.writeError(`${USAGE}\n`);
          return 1;
        }
        const path = resolve(cmd.cwd, pathArg);
        return sub === 'add' ? await labelAdd(cmd, path, labels) : await labelRemove(cmd, path, labels);
      }
      case 'list':
        return await labelList(cmd, pathArg ? resolve(cmd.cwd, pathArg) : undefined);
      case 'prune':
        return await labelPrune(cmd);
      default:
        await cmd.writeError(`${USAGE}\n`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`label: ${message}\n`);
    return 1;
  }
};

label.spec = {
  name: 'label',
  effect: 'read' as const,
  description: 'Manage labels/tags (add, remove, list, prune)',
  args: [
    { name: 'subcommand', writes: ['add', 'remove', 'prune'], type: 'string' as const, description: 'add | remove | list | prune' },
    { name: 'path', type: 'path' as const, description: 'node path' },
    { name: 'label', type: 'string' as const, description: 'label name(s)' },
  ],
  flags: [],
  examples: [
    'label add /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg exempeletikett',
    'label list /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
  ],
  returns: 'for `list`, the labels on the node; for `add` and `remove`, nothing.',
};

/** `labels [<path>]` — list all labels, or a node's labels */
export const labels = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const pathArg = flags._[0] as string | undefined;
  try {
    return await labelList(cmd, pathArg ? resolve(cmd.cwd, pathArg) : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`labels: ${message}\n`);
    return 1;
  }
};

labels.spec = {
  name: 'labels',
  effect: 'read' as const,
  description: 'List labels (all, or of a node); search --tag <label> finds what carries one',
  args: [
    { name: 'path', type: 'path' as const, description: 'node path (optional)', optional: true },
  ],
  flags: [],
  examples: [
    'labels',
    'labels /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
  ],
  returns: 'without a path, every label in use with how many nodes carry it ({ label, count }); with one, the labels on that node.',
};
