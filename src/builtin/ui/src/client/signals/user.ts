import { computed, signal } from '@preact/signals-react';
import { execCommand } from './shell-client.ts';
import { openRoute } from './module-ui.ts';
import { resetTerminalWorkspace } from './terminal.ts';
import { shq } from '../lib/shquote.ts';
import type { HeldShareLink, ShareLinkOpened, Whoami } from '@ein/api';

/** The signed-in account as `user-whoami` answers (`@ein/api` `Whoami`), with its avatar. */
export type User = Whoami & {
  avatarUrl: string;
};

/**
 * Current authenticated user (null if not logged in)
 */
export const currentUser = signal<User | null>(null);

/** Whether someone is signed in, rather than the guest. */
export const isAuthenticated = computed(() => currentUser.value !== null);

/**
 * Whether the administrator opens the archive to the guest (`CFG_GUEST_BROWSING`): a visitor who
 * has not signed in then browses what is shared with everyone, rather than being sent to sign in.
 */
export const guestBrowsing = signal(false);

/**
 * The share link this browser opened last, while it still opens something — a session holds one at
 * most: a visitor who has not signed in sees what it opens, wherever visitors may not browse otherwise.
 */
export const heldLinks = signal<HeldShareLink[]>([]);

/** Someone held to what their share link opens: not signed in, where visitors may not browse. */
export const linkVisitor = computed(() => !isAuthenticated.value && !guestBrowsing.value && heldLinks.value.length > 0);

/** The page the held link opens; empty when no installed page shows it. */
export const heldLinkRoutes = computed(() =>
  heldLinks.value.flatMap((link) => {
    const route = openRoute(link.type, link.path);
    return route ? [{ ...link, route }] : [];
  })
);

/**
 * Open a share link in this browser's session. The caller then loads the page it opens afresh: what
 * was read so far was read without it.
 */
export async function openShareLink(token: string): Promise<ShareLinkOpened> {
  return await execCommand<ShareLinkOpened>(`share-link open ${shq(token)} --session`);
}

/**
 * Check current auth status by calling whoami
 */
export async function checkAuth(): Promise<void> {
  try {
    const result = await execCommand<Whoami>('user-whoami');

    if (result.username !== 'guest') {
      currentUser.value = {
        ...result,
        avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(result.username)}&background=0d9488&color=fff`,
      };
    } else {
      currentUser.value = null;
    }
    guestBrowsing.value = result.guestBrowsing === true;
    heldLinks.value = result.links ?? [];
  } catch {
    currentUser.value = null;
    guestBrowsing.value = false;
    heldLinks.value = [];
  }
}

/**
 * Sign this session in. The caller then loads the page again: everything read so far — the
 * navigation, the settings, what the pages hold — was read as the guest.
 */
export async function login(username: string, password: string): Promise<void> {
  await execCommand(`login --session ${shq(username)} ${shq(password)}`);
}

/**
 * Sign this session out, back to the guest. The caller then loads the page again, as after
 * `login`.
 *
 * The server ends this session's terminals; the tabs stored for this browser
 * tab go too, so they are not reopened as fresh shells under the old titles.
 */
export async function logout(): Promise<void> {
  try {
    await execCommand('logout --session');
  } catch {
    // Ignore errors
  }
  currentUser.value = null;
  resetTerminalWorkspace();
}

/**
 * Make this session's sign-in an administrator's (`user-elevate`), for a member of the `sudo` group
 * who entered their `password` again. The caller then loads the page again: the navigation, the
 * settings and the access ids were read without it.
 */
export async function elevate(password: string): Promise<void> {
  await execCommand(`user-elevate --session --password=${shq(password)}`);
}

/** Make this session's sign-in no longer an administrator's; the caller loads the page again, as after `elevate`. */
export async function leaveElevation(): Promise<void> {
  await execCommand('user-elevate --off --session');
}

export async function updateUser(username: string, name: string, description: string): Promise<void> {
  await execCommand(`user-update ${shq(username)} --name=${shq(name)} --description=${shq(description)}`);

  await checkAuth();
}

/** `--flag=value` so a password that starts with a dash is not read as another flag. */
export async function changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
  await execCommand(`user-passwd ${shq(username)} --old-password=${shq(oldPassword)} --new-password=${shq(newPassword)}`);
  await checkAuth();
}
