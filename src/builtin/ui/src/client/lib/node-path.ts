/**
 * Path arithmetic for the nodes explorer.
 *
 * VFS paths are POSIX-shaped: `/` separated, absolute, no scheme. Everything
 * here works on strings only; whether a path exists is the server's business.
 */

/** Collapse `//`, resolve `.` and `..`, drop a trailing `/`. Always absolute. */
export function normalizePath(input: string): string {
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

export function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** The parent of `/` is `/`; the address bar's "up" must never leave the root. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Why `name` cannot name a node, or `null` when it can. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return 'A name is needed';
  if (/[/\0]/.test(name)) return 'A name cannot contain /';
  if (name === '.' || name === '..') return 'Not a name';
  return null;
}

/** Path segments for a breadcrumb: `/a/b` → `[['a','/a'],['b','/a/b']]`. */
export function pathCrumbs(path: string): { name: string; path: string }[] {
  const crumbs: { name: string; path: string }[] = [];
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current = `${current}/${segment}`;
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** `true` when `path` is `ancestor` itself or lies somewhere under it. */
export function isInside(path: string, ancestor: string): boolean {
  if (ancestor === '/') return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Whether dropping `sources` on `target` makes sense before asking the server.
 *
 * A node cannot be dropped on itself or into its own subtree — the server
 * would refuse the first and the second is a cycle. A move to the directory
 * a node already lives in is a no-op and is rejected too, so the drop
 * indicator does not light up on a drag that goes nowhere; a copy into the
 * same directory would collide on the name, so it is rejected for the same
 * reason.
 */
export function dropAllowed(sources: string[], target: string): boolean {
  if (sources.length === 0) return false;
  for (const source of sources) {
    if (isInside(target, source)) return false;
    if (parentPath(source) === target) return false;
  }
  return true;
}
