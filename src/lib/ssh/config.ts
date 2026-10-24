/**
 * Reading OpenSSH's client configuration, `~/.ssh/config` in the VFS: which
 * settings apply to a host, in ssh_config(5)'s terms.
 */

import { globToRegExp } from '@std/path';
import * as posix from '@std/path/posix';
import type { Access } from '../access/types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { readText, sshDir } from './files.ts';

/** Who is asking, which the `Host` and `Match` lines are tested against */
interface SshConfigQuery {
  /** The host as given on the command line */
  host: string;
  /** The remote user when the command line names one */
  user?: string;
  /** The local (EiN) user */
  localUser: string;
}

/** OpenSSH stops following `Include` this deep */
const MAX_INCLUDE_DEPTH = 16;

/**
 * A line's keyword (lowercase) and arguments: `Keyword value` or
 * `Keyword=value`, a `"…"` argument may hold spaces, `#` starts a comment.
 */
function parseLine(line: string): { keyword: string; args: string[] } | undefined {
  const m = line.match(/^\s*([^\s=#]+)\s*(?:=\s*)?(.*)$/);
  if (!m) return undefined;
  const args = [...m[2].matchAll(/"([^"]*)"|(#.*)|(\S+)/g)];
  const end = args.findIndex((a) => a[2] !== undefined);
  return {
    keyword: m[1].toLowerCase(),
    args: (end < 0 ? args : args.slice(0, end)).map((a) => a[1] ?? a[3]),
  };
}

/** Whether `name` matches an ssh_config pattern list: any pattern, and no `!` one */
export function matchPatternList(name: string, patterns: string[]): boolean {
  let matched = false;
  for (const pattern of patterns.flatMap((p) => p.split(','))) {
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    const re = globToRegExp(negated ? pattern.slice(1) : pattern, { extended: false, globstar: false, caseInsensitive: true });
    if (!re.test(name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/**
 * The settings that apply to a host, keyword (lowercase) to value. As in
 * OpenSSH the first value found for a keyword is the one used, so the more
 * specific `Host` blocks go first in the file. `IdentityFile` keeps its first
 * value only. An unreadable or missing file gives no settings.
 *
 * `Match` understands `all`, `host`, `originalhost`, `user` and `localuser`;
 * a block with any other criterion does not apply.
 */
export async function readSshConfig(
  vfs: NodeVFS,
  access: Access,
  home: string,
  path: string,
  query: SshConfigQuery,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  const matches = (words: string[]): boolean => {
    for (let i = 0; i < words.length; i++) {
      const criterion = words[i].toLowerCase();
      if (criterion === 'all') continue;
      const arg = words[++i];
      if (arg === undefined) return false;
      const patterns = arg.split(',');
      const value = criterion === 'host'
        ? found.get('hostname') ?? query.host
        : criterion === 'originalhost'
        ? query.host
        : criterion === 'user'
        ? query.user ?? found.get('user') ?? query.localUser
        : criterion === 'localuser'
        ? query.localUser
        : undefined;
      if (value === undefined || !matchPatternList(value, patterns)) return false;
    }
    return true;
  };

  const readFile = async (file: string, depth: number) => {
    const text = await readText(vfs, access, file).catch(() => undefined);
    if (text === undefined) return;

    let applies = true;
    for (const raw of text.split('\n')) {
      const line = parseLine(raw);
      if (!line) continue;
      const { keyword, args } = line;

      if (keyword === 'host') {
        applies = matchPatternList(query.host, args);
      } else if (keyword === 'match') {
        applies = matches(args);
      } else if (!applies) {
        continue;
      } else if (keyword === 'include') {
        if (depth >= MAX_INCLUDE_DEPTH) continue;
        for (const pattern of args) {
          for (const included of await expandInclude(vfs, access, home, pattern)) await readFile(included, depth + 1);
        }
      } else if (!found.has(keyword) && args.length) {
        found.set(keyword, args.join(' '));
      }
    }
  };

  await readFile(path, 0);
  return found;
}

/** An `Include` argument: `~` is the home, a relative path is under `~/.ssh`, the last segment may be a glob */
async function expandInclude(vfs: NodeVFS, access: Access, home: string, pattern: string): Promise<string[]> {
  const path = pattern.startsWith('~/') ? posix.join(home, pattern.slice(2)) : posix.resolve(sshDir(home), pattern);
  const name = posix.basename(path);
  if (!/[*?[]/.test(name)) return [path];

  const dir = posix.dirname(path);
  const re = globToRegExp(name, { extended: false, globstar: false });
  const children = await vfs.children(access, dir).catch(() => []);
  return children.map((c) => c.name).filter((n) => re.test(n) && !n.startsWith('.')).sort().map((n) => posix.join(dir, n));
}
