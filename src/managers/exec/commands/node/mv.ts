import { basename, dirname, join, resolve } from '@std/path';
import type { MvAnswer } from '../../../../lib/api/node.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Move sources into an existing destination that is not a file, or one source to a new path or
 * onto a file it replaces, in one `renameMany`:
 * the softlinks at each moved path or under it are re-pointed in the moves' own transactions.
 * Each source that does not move is reported on stderr and in the answer's `failed`.
 */
export const mv = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['no-clobber', 'no-relink'],
    alias: {
      n: 'no-clobber',
    },
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const args = flags._;

  if (args.length < 2) {
    await cmd.writeError('mv: missing file operand\n');
    await cmd.writeError('Usage: mv [-n|--no-clobber] [--no-relink] SOURCE... DEST\n');
    return 1;
  }

  const sources = args.slice(0, -1).map((arg) => ({ arg, path: resolve(cmd.cwd, arg) }));
  const destArg = args.at(-1)!;
  const destPath = resolve(cmd.cwd, destArg);
  const dest = await cmd.sys.vfs.exists(cmd.access, destPath) ? await cmd.sys.vfs.get(cmd.access, destPath) : undefined;
  const destExists = dest !== undefined;
  // Any node can hold children, so an existing DEST takes the sources as a directory does, unless
  // it is a file: a file named as DEST is the one the move replaces.
  const into = destExists && dest.type !== NODE_TYPE_FILE;

  // A trailing slash names a directory: one that must exist (a softlink to one counts), never a
  // file, though a file can hold children.
  if (destArg.endsWith('/') && destPath !== '/') {
    if (!destExists) {
      await cmd.writeError(`mv: cannot move to '${destArg}': No such file or directory\n`);
      return 1;
    }
    if (dest.type !== NODE_TYPE_DIRECTORY) {
      await cmd.writeError(`mv: cannot move to '${destArg}': Not a directory\n`);
      return 1;
    }
  }
  if (sources.length > 1 && !into) {
    await cmd.writeError(destExists ? `mv: target '${destArg}' is not a directory\n` : `mv: target '${destArg}' is not an existing node\n`);
    return 1;
  }
  const [first] = sources;
  if (destExists && !into && await cmd.sys.vfs.exists(cmd.access, first.path) && (await cmd.sys.vfs.get(cmd.access, first.path)).type !== NODE_TYPE_FILE) {
    await cmd.writeError(`mv: cannot overwrite file '${destArg}' with '${first.arg}', which is not a file\n`);
    return 1;
  }
  if (!destExists && !await cmd.sys.vfs.exists(cmd.access, dirname(destPath))) {
    await cmd.writeError(`mv: cannot create '${destArg}': No such file or directory\n`);
    return 1;
  }

  const interrupt = new AbortController();
  cmd.onInterrupt(() => interrupt.abort());

  const settled = await cmd.sys.vfs.renameMany(
    cmd.access,
    sources.map(({ path }) => ({ from: path, to: into ? join(destPath, basename(path)) : destPath })),
    { failIfExists: flags['no-clobber'], relink: !flags['no-relink'], signal: interrupt.signal },
  );

  const answer: MvAnswer = { ok: true, moved: 0, relinked: 0, failed: [] };
  for (const [i, outcome] of settled.entries()) {
    const { arg, path } = sources[i];
    if (outcome.status === 'fulfilled' && !outcome.value.already) {
      answer.moved++;
      answer.relinked += outcome.value.relinked;
      continue;
    }
    // A source already gone, with something at its destination, is still a source that is not there.
    const error = outcome.status === 'rejected' ? (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)) : 'no such file or directory';
    answer.failed.push({ path, error });
    await cmd.writeError(`mv: cannot move '${arg}': ${error}\n`);
  }
  answer.ok = answer.failed.length === 0;

  if (cmd.json) await cmd.writeJSON(answer satisfies MvAnswer);
  // A source that did not move is reported, and fails the command only when none moved: the API
  // shell drops the answer of a command that exits non-zero, and a partly made move must still
  // say what it moved.
  return answer.moved === 0 && !answer.ok ? 1 : 0;
};

mv.spec = {
  name: 'mv',
  effect: 'write' as const,
  description: 'Move or rename files and directories, re-pointing the softlinks at each moved path or anywhere under it (and a relation link’s peerLink with them)',
  args: [
    {
      name: 'source',
      type: 'path' as const,
      description: 'the files or directories to move; several go into DEST, which must exist',
    },
    {
      name: 'dest',
      type: 'path' as const,
      description: 'destination: an existing node that is not a file to move into, or the new path of a single source, replacing a file there',
    },
  ],
  flags: [
    { name: 'no-clobber', type: 'bool' as const, description: 'Do not overwrite an existing file - fails if destination already exists (-n)' },
    { name: 'no-relink', type: 'bool' as const, description: 'Leave the softlinks that point at or under each moved source on its old path' },
  ],
  examples: [
    'mv /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg /archive/albums/Exempelalbum_2019/files/nytt_namn.jpg',
    'mv /home/anna/staging/files/inbox/upload-2026-10-16 /home/anna/staging/files/scans/',
  ],
  returns:
    'in JSON mode, MvAnswer: how many sources moved, how many softlinks were re-pointed, and each source that did not move with why. Exits non-zero only when no source moved.',
};
