/**
 * The caches the service worker keeps (`sw.ts`), by name, for it and for the page that empties them.
 * Import-free: the service worker is bundled on its own.
 */

/**
 * The Web UI itself, the same for every reader: the document, the shell's and the modules' bundles,
 * the modules' manifest, fonts and icons. Kept across signing out.
 */
export const SHELL_CACHE = 'ein-shell';

/**
 * Pictures and documents a reader opened recently, to show while EiN is out of reach. A reader's
 * own: the page empties it when they sign out and when another account signs in.
 */
export const FILES_CACHE = 'ein-files';

/**
 * Files another app shared to EiN (the web manifest's `share_target`), from the moment the service
 * worker takes them until the `/share` page hands them on.
 */
export const SHARED_CACHE = 'ein-shared';

/** The header a shared file's name is kept in, URI-encoded; its type is its `content-type`. */
export const SHARED_NAME_HEADER = 'x-ein-name';

/** Every cache the service worker keeps; any other on the origin is an older one, and goes. */
export const OWN_CACHES: readonly string[] = [SHELL_CACHE, FILES_CACHE, SHARED_CACHE];
