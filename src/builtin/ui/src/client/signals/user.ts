import { computed, signal } from '@preact/signals-react';
import { execCommand, OfflineError } from './shell-client.ts';
import { forgetReader, keepFor, readerOf } from './offline.ts';
import { openRoute } from './module-ui.ts';
import { resetTerminalWorkspace } from './terminal.ts';
import { shq } from '../lib/shquote.ts';
import type { HeldShareLink, ShareLinkOpened, Whoami } from '@ein/api';

/**
 * Current authenticated user as `user-whoami` answers (null if not logged in)
 */
export const currentUser = signal<Whoami | null>(null);

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
    const route = link.route ?? openRoute(link.type, link.path);
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
 * Whether the auth check could not be answered: EiN is out of reach and this device kept nothing of
 * it, so there is no one to draw the page for.
 */
export const authOutOfReach = signal(false);

/**
 * Check current auth status by calling whoami, and keep what the page reads for whoever it is
 * (`keepFor`). Out of reach, the answer this device kept says who last read here.
 */
export async function checkAuth(): Promise<void> {
  authOutOfReach.value = false;
  try {
    const result = await execCommand<Whoami>('user-whoami');

    if (result.username !== 'guest') {
      currentUser.value = result;
    } else {
      currentUser.value = null;
    }
    guestBrowsing.value = result.guestBrowsing === true;
    heldLinks.value = result.links ?? [];
    void keepFor(readerOf(result));
  } catch (error) {
    currentUser.value = null;
    guestBrowsing.value = false;
    heldLinks.value = [];
    authOutOfReach.value = error instanceof OfflineError;
  }
}

/**
 * Sign this session in. The caller then loads the page again: everything read so far — the
 * navigation, the settings, what the pages hold — was read as the guest.
 *
 * Every password here goes on stdin, as `-`: a command line is what `ps` shows, and everyone
 * holding the same share link shares a uid.
 */
export async function login(username: string, password: string): Promise<void> {
  await execCommand(`login --session ${shq(username)} -`, { stdin: password });
}

/**
 * Sign this session out, back to the guest. The caller then loads the page again, as after
 * `login`.
 *
 * The server ends this session's terminals; the tabs stored for this browser
 * tab go too, so they are not reopened as fresh shells under the old titles. What this device kept
 * to read without a connection goes as well.
 */
export async function logout(): Promise<void> {
  try {
    await execCommand('logout --session');
  } catch {
    // Ignore errors
  }
  currentUser.value = null;
  resetTerminalWorkspace();
  await forgetReader();
}

/**
 * Make this session's sign-in an administrator's (`user-elevate`), for a member of the `sudo` group
 * who entered their `password` again. The caller then loads the page again: the navigation, the
 * settings and the access ids were read without it.
 */
export async function elevate(password: string): Promise<void> {
  await execCommand('user-elevate --session --password=-', { stdin: password });
}

/** Make this session's sign-in no longer an administrator's; the caller loads the page again, as after `elevate`. */
export async function leaveElevation(): Promise<void> {
  await execCommand('user-elevate --off --session');
}

export async function updateUser(username: string, name: string, description: string): Promise<void> {
  await execCommand(`user-update ${shq(username)} --name=${shq(name)} --description=${shq(description)}`);

  await checkAuth();
}

/** Both passwords on stdin, the current one's line first. */
export async function changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
  await execCommand(`user-passwd ${shq(username)} --old-password=- --new-password=-`, { stdin: `${oldPassword}\n${newPassword}` });
  await checkAuth();
}
