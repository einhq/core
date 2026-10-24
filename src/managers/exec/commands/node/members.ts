/**
 * members — who is in a container: a node of a type with rules of its own answered by that type's
 * `members-<type>` command, anything else listed as a directory. The same rule `search --under`
 * uses, for anyone else who asks.
 */

import { resolve } from '@std/path';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { ContainerListing } from '../../../../lib/containers/types.ts';
import { containerListing } from '../../../../lib/search/containers.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const members = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const [arg] = flags._.map(String);
  if (!arg) {
    await cmd.writeError('members: expected a path\n');
    return 1;
  }

  let listing: ContainerListing;
  try {
    listing = await containerListing(cmd, resolve(cmd.cwd, arg));
  } catch (error) {
    await cmd.writeError(`members: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON(listing satisfies ContainerListing);
    return 0;
  }
  for (const member of listing.members) await cmd.writeLn(member.memberPath && member.memberPath !== member.path ? `${member.memberPath} -> ${member.path}` : member.path);
  if (listing.truncated) await cmd.writeLn('(more members exist than were listed)');
  return 0;
};

members.spec = {
  name: 'members',
  effect: 'read' as const,
  description: "Who is in a container: an album's members by its rules, or a directory's media",
  args: [{ name: 'path', type: 'path' as const, description: 'The container' }],
  flags: [],
  examples: ['members /archive/albums/Exempelalbum_2019', 'members /archive/tags/segling'],
  returns: "every member's path, node id and, for a member held by a link, the link; with a type's own command (members-<type>), also which member stands for a folded group.",
};
