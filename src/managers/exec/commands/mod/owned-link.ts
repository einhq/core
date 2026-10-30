import { dirname } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';

/**
 * A file of a module's, linked into `/etc` where it is read: its navigation
 * (`/etc/ui/nav.d/<module>.json`), its settings (`/etc/config.d/<module>`), a drop-in directory
 * (`/etc/<x>.d/<module>`).
 *
 * Owned the way services and pipelines are: the link is the module's while it points into the
 * module's directory. One pointing anywhere else was put there by an operator and is neither
 * replaced nor removed.
 */
export type OwnedLink = {
  /** The module's file. */
  source: string;
  /** Where it is linked. */
  linkPath: string;
  /** What it is, for the setup log: "navigation", "settings", the drop-in's directory. */
  what: string;
  /** The module no longer wants it here, as when its navigation moved to its groups': retired like a file it stopped shipping. */
  retire?: boolean;
};

/** Where the link points, `undefined` when there is none, `null` when it is not a link. */
const currentTarget = async (cmd: Command, linkPath: string): Promise<string | null | undefined> => {
  try {
    const node = await cmd.sys.vfs.get(ADMIN_ACCESS, linkPath, { follow: false });
    return typeof node.props.softlink === 'string' ? node.props.softlink : null;
  } catch {
    return undefined;
  }
};

const unlink = async (cmd: Command, linkPath: string): Promise<void> => {
  await cmd.sys.vfs.unlink(ADMIN_ACCESS, linkPath, dirname(linkPath), { readlink: true });
};

/** Link the module's file, or retire the link when it no longer ships one. Returns a problem, if any. */
export const linkOwned = async (cmd: Command, modulePath: string, { source, linkPath, what, retire }: OwnedLink): Promise<string | undefined> => {
  const target = await currentTarget(cmd, linkPath);
  const owned = typeof target === 'string' && target.startsWith(`${modulePath}/`);
  const ships = !retire && await cmd.sys.vfs.exists(cmd.access, source);

  if (!ships) {
    if (owned) {
      await unlink(cmd, linkPath);
      if (!cmd.json) await cmd.write(`  Retired ${what} at ${linkPath}\n`);
    }
    return undefined;
  }
  if (target === source) {
    if (!cmd.json) await cmd.write(`  ${what[0].toUpperCase()}${what.slice(1)} already linked at ${linkPath}\n`);
    return undefined;
  }
  if (target !== undefined && !owned) {
    if (!cmd.json) await cmd.write(`  ${what[0].toUpperCase()}${what.slice(1)} at ${linkPath} is not this module's, left alone\n`);
    return undefined;
  }
  if (owned) await unlink(cmd, linkPath);

  await cmd.execute(`mkdir -p ${shq(dirname(linkPath))}`);
  const res = await cmd.execute(`ln -s ${shq(source)} ${shq(linkPath)}`);
  if (res.code !== 0) return `failed to link ${what}: ${res.stderr}`;
  if (!cmd.json) await cmd.write(`  Linked ${what} at ${linkPath}\n`);
  return undefined;
};

/** Remove the module's link, if it is the module's. */
export const unlinkOwned = async (cmd: Command, modulePath: string, { linkPath, what }: OwnedLink): Promise<void> => {
  const target = await currentTarget(cmd, linkPath);
  if (typeof target !== 'string' || !target.startsWith(`${modulePath}/`)) return;
  try {
    await unlink(cmd, linkPath);
    if (!cmd.json) await cmd.write(`  Unlinked ${what} at ${linkPath}\n`);
  } catch (error) {
    await cmd.writeError(`  failed to unlink ${what}: ${(error as Error).message}\n`);
  }
};
