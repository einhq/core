import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import { ADMIN_ACCESS, ADMIN_UID, GUEST_UID, isAdmin, isVisitor, SUDO_GROUPNAME } from '../../../../lib/access/mod.ts';
import { isMemberOf } from '../../../../lib/auth/member-gids.ts';
import { guestMayBrowse } from '../../../../lib/config/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import type { Whoami } from '../../../../lib/api/mod.ts';
import { heldShareLinks } from '../node/share/links.ts';

export const userWhoami = async (cmd: Command): CmdReturn => {
  const uid = cmd.access.uid;

  try {
    const users = (await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)).filter((entry) => isUserNode(entry.node));
    // A share link's principal has no account of its own: it answers as the guest, with its link.
    const userEntry = users.find((entry) => entry.node.attrs.uid === (cmd.access.link ? GUEST_UID : uid));

    if (!userEntry) {
      await cmd.writeError(`user whoami: uid ${uid} not found\n`);
      return 1;
    }

    // A user's optional `person` softlink is their identity in the archive. Read the
    // link itself, which may point at a person not imported yet.
    const personLink = await cmd.sys.vfs.get(cmd.access, `${cmd.env.USERS_PATH}/${userEntry.name}/person`, { follow: false }).catch(() => undefined);
    const personPath = personLink?.props.softlink || undefined;

    // What the session's share links open, so the web UI lets a visitor without an account there.
    const links = await heldShareLinks(cmd);

    // Read as the administrator: someone added to `sudo` since signing in may not list it yet.
    const mayElevate = !isVisitor(cmd.access) && uid !== ADMIN_UID && !cmd.access.admin &&
      await isMemberOf(cmd.sys.vfs, ADMIN_ACCESS, SUDO_GROUPNAME, userEntry.name, userEntry.node);

    if (cmd.json) {
      await cmd.write(
        JSON.stringify(
          {
            id: userEntry.node.id,
            username: userEntry.name,
            ...userEntry.node.attrs,
            ...(personPath ? { personPath } : {}),
            // Administrator is a property of this authenticated access context,
            // not a file mode bit or necessarily a persisted user attribute. Each is
            // set whatever its value, over any attr of that name the user gave their node.
            admin: isAdmin(cmd.access),
            elevated: cmd.access.elevated === true,
            mayElevate,
            // Whether visitors who have not signed in browse: the web UI lets the guest in on it, and
            // tells a signed-in reader whether what visitors are granted is public.
            guestBrowsing: await guestMayBrowse(cmd.sys.vfs),
            ...(links.length > 0 ? { links } : {}),
          } satisfies Whoami,
        ),
      );
    } else {
      await cmd.write(`${userEntry.name}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user whoami: ${message}\n`);
    return 1;
  }
};

userWhoami.spec = {
  name: 'user-whoami',
  guest: true,
  effect: 'read' as const,
  description: 'Print the current username',
};
