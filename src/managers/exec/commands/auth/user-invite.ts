/**
 * Sign-in links: how someone gets into an account without an administrator choosing the password
 * for them — an account that has none yet, or whose person forgot it.
 *
 *   user-invite <user> [--new [--days <n>]|--off]     an administrator shows, makes or takes away the link
 *   user-invite-accept <token> [--password=<p>]      whoever holds it sees which account it is for, and chooses its password
 *
 * The administrator sends the link however they like; EiN sends no e-mail. Choosing a password
 * with it spends it, sets the password whether or not the account had one, and signs in.
 */

import { join } from '@std/path';
import { isAdmin } from '../../../../lib/access/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { setAccountPassword } from '../../../../lib/auth/account-password.ts';
import { accountByInvite, DEFAULT_INVITE_DAYS, MAX_INVITE_DAYS, newInvite, readInvite, removeInvite } from '../../../../lib/auth/invite.ts';
import { userRole } from '../../../../lib/auth/roles.ts';
import type { UserInvite, UserInviteAccepted } from '../../../../lib/api/users.ts';
import { isUserNode, type UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const fail = async (cmd: Command, name: string, message: string): Promise<number> => {
  await cmd.writeError(`${name}: ${message}\n`);
  return 1;
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const userInvite = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['new', 'off'], string: ['days'] });
  const username = String(flags._[0] ?? '');
  if (!username) return await fail(cmd, 'user-invite', 'usage: user-invite <user> [--new [--days <n>]|--off]');
  if (!isAdmin(cmd.access)) return await fail(cmd, 'user-invite', 'only an administrator makes sign-in links');
  if (flags.new && flags.off) return await fail(cmd, 'user-invite', '--new and --off do not go together');

  const days = flags.days === undefined ? DEFAULT_INVITE_DAYS : Number(flags.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS) {
    return await fail(cmd, 'user-invite', `--days takes a whole number of days from 1 to ${MAX_INVITE_DAYS}, not '${flags.days}'`);
  }
  if (flags.days !== undefined && !flags.new) return await fail(cmd, 'user-invite', '--days goes with --new');

  try {
    const userPath = join(cmd.env.USERS_PATH, username);
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath).catch(() => undefined);
    if (!user || !isUserNode(user)) return await fail(cmd, 'user-invite', `no such account: ${username}`);
    if (userRole(username, user.attrs.uid) === 'guest') return await fail(cmd, 'user-invite', 'the guest account cannot have a password');
    if (flags.new && user.attrs.inactive) return await fail(cmd, 'user-invite', `${username} is disabled; enable it first`);

    if (flags.off) await removeInvite(cmd.sys.vfs, userPath);
    const record = flags.new
      ? await newInvite(cmd.sys.vfs, userPath, cmd.access.uid, Date.now() + days * DAY_MS)
      : flags.off
      ? undefined
      : await readInvite(cmd.sys.vfs, userPath);

    const answer: UserInvite = record ? { username, token: record.attrs.token, createdAt: record.attrs.createdAt, expiresAt: record.attrs.expiresAt } : { username };
    if (cmd.json) await cmd.writeJSON(answer satisfies UserInvite);
    else if (record) await cmd.writeLn(`/invite/${record.attrs.token}  until ${new Date(record.attrs.expiresAt).toISOString()}`);
    else await cmd.writeLn(`${username} has no sign-in link`);
    return 0;
  } catch (error) {
    return await fail(cmd, 'user-invite', errorText(error));
  }
};

userInvite.spec = {
  name: 'user-invite',
  effect: 'read' as const,
  description:
    "An account's sign-in link, with which its person chooses their own password at /invite/<token>: shown, made new (--new) or taken away (--off); for an administrator",
  args: [{ name: 'username', type: 'user' as const, description: 'the account' }],
  flags: [
    { name: 'new', type: 'bool' as const, writes: true, description: 'make a new link; one sent before stops working' },
    { name: 'days', type: 'string' as const, description: `with --new: how many days it works, 1 to ${MAX_INVITE_DAYS} (default ${DEFAULT_INVITE_DAYS})` },
    { name: 'off', type: 'bool' as const, writes: true, description: 'take the link away' },
  ],
  examples: ['user-invite anna --new', 'user-invite anna', 'user-invite anna --off'],
  returns: 'UserInvite',
};

export const userInviteAccept = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['password'], boolean: ['session'] });
  const token = String(flags._[0] ?? '');
  // A token that names nothing, an expired one and one whose account is disabled get the same
  // answer, which tells a guesser nothing.
  const dead = 'this sign-in link does not work any more';

  try {
    const account = await accountByInvite(cmd.sys.vfs, token);
    if (!account) return await fail(cmd, 'user-invite-accept', dead);
    const { username, userPath, userNode } = account;
    const title = userNode.attrs.name;

    if (flags.password === undefined) {
      const answer: UserInviteAccepted = { username, ...(title ? { title } : {}), signedIn: false };
      if (cmd.json) await cmd.writeJSON(answer satisfies UserInviteAccepted);
      else await cmd.writeLn(`For ${username}${title ? ` (${title})` : ''}`);
      return 0;
    }
    if (flags.password === '') return await fail(cmd, 'user-invite-accept', 'the password cannot be empty');

    // Spent first: two who hold the link at once cannot both choose the password.
    await removeInvite(cmd.sys.vfs, userPath);
    await setAccountPassword(cmd.sys.vfs, { ...cmd.access, admin: true }, userPath, flags.password, cmd.launchEnv);
    if (userNode.attrs.mustResetPassword) {
      await cmd.sys.vfs.update<UserAttrs>({ ...cmd.access, admin: true }, userPath, { attrs: { mustResetPassword: false } });
    }
    await cmd.login(username, flags.password, flags.session);

    const answer: UserInviteAccepted = { username, ...(title ? { title } : {}), signedIn: true };
    if (cmd.json) await cmd.writeJSON(answer satisfies UserInviteAccepted);
    else await cmd.writeLn(`Password set; signed in as ${username}`);
    return 0;
  } catch (error) {
    return await fail(cmd, 'user-invite-accept', errorText(error));
  }
};

userInviteAccept.spec = {
  name: 'user-invite-accept',
  guest: true,
  effect: 'read' as const,
  description: 'Which account a sign-in link is for, and with --password, choose its password with it, which spends the link and signs in',
  args: [{ name: 'token', type: 'string' as const, description: 'the token after /invite/ in the link' }],
  flags: [
    { name: 'password', type: 'string' as const, writes: true, description: "the account's new password; give it as --password=<p>" },
    { name: 'session', type: 'bool' as const, description: 'sign in the whole session, not just this shell' },
  ],
  examples: ['user-invite-accept AbCdEfGhIjKlMnOpQrStUv', 'user-invite-accept AbCdEfGhIjKlMnOpQrStUv --password=correct-horse --session'],
  returns: 'UserInviteAccepted',
};
