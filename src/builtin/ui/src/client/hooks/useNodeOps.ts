import { useCallback, useState } from 'react';
import type { MvAnswer } from '@ein/api';
import { parentPath } from '../lib/node-path.ts';
import { shq } from '../lib/shquote.ts';
import { invalidateListing, nodeClipboard } from '../signals/nodes.ts';
import { execCommand } from '../signals/shell-client.ts';

export type NodeOps = {
  error: Error | null;
  clearError: () => void;
  busy: boolean;
  move: (paths: string[], dest: string) => Promise<boolean>;
  copy: (paths: string[], dest: string) => Promise<boolean>;
  rename: (path: string, name: string) => Promise<boolean>;
  remove: (paths: string[], recursive: boolean) => Promise<boolean>;
  mkdir: (parent: string, name: string) => Promise<boolean>;
  chmod: (path: string, mode: number) => Promise<boolean>;
  chown: (path: string, user: string, group?: string) => Promise<boolean>;
  /** Paste the clipboard into `dest`; a cut clipboard is emptied afterwards. */
  paste: (dest: string) => Promise<boolean>;
};

const unique = (paths: string[]) => [...new Set(paths)];

/** The sources a move answered it could not move, one line each, or undefined when it moved every one. */
const moveRefused = (answer: MvAnswer) => answer.failed.length > 0 ? answer.failed.map((entry) => `${entry.path}: ${entry.error}`).join('\n') : undefined;

/**
 * The explorer's writes, each one shell command, each followed by a bump of
 * the listings it changed.
 *
 * The bump is what makes a paste show up at once: the server's event arrives
 * too, but after the watcher's settle delay, and a paste that takes a second
 * to appear is a paste that gets clicked twice. The server remains the
 * authority on whether any of it is allowed — a refusal lands in `error`.
 */
export function useNodeOps(): NodeOps {
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  /** Run `command`; `refused` turns an answer that says some of it was refused into the error shown. */
  const run = useCallback(async <T>(command: string, touched: string[], refused?: (answer: T) => string | undefined): Promise<boolean> => {
    setBusy(true);
    try {
      const answer = await execCommand<T>(command);
      const problem = refused?.(answer);
      setError(problem === undefined ? null : new Error(problem));
      invalidateListing(...unique(touched));
      return problem === undefined;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      // Some of it may have happened before the failure — a copy of several
      // sources goes on past one it cannot make — so what is shown is refreshed
      // regardless.
      invalidateListing(...unique(touched));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const move = useCallback((paths: string[], dest: string) => run(`mv ${paths.map(shq).join(' ')} ${shq(dest)}`, [...paths.map(parentPath), dest], moveRefused), [run]);
  const copy = useCallback((paths: string[], dest: string) => run(`cp -r ${paths.map(shq).join(' ')} ${shq(dest)}`, [dest]), [run]);
  const rename = useCallback((path: string, name: string) => {
    const parent = parentPath(path);
    return run(`mv ${shq(path)} ${shq(parent === '/' ? `/${name}` : `${parent}/${name}`)}`, [parent], moveRefused);
  }, [run]);
  const remove = useCallback((paths: string[], recursive: boolean) => run(`rm ${recursive ? '-r ' : ''}${paths.map(shq).join(' ')}`, paths.map(parentPath)), [run]);
  const mkdir = useCallback((parent: string, name: string) => run(`mkdir ${shq(parent === '/' ? `/${name}` : `${parent}/${name}`)}`, [parent]), [run]);
  const chmod = useCallback((path: string, mode: number) => run(`chmod ${(mode & 0o777).toString(8)} ${shq(path)}`, [parentPath(path)]), [run]);
  const chown = useCallback(
    (path: string, user: string, group?: string) => run(`chown ${shq(group ? `${user}:${group}` : user)} ${shq(path)}`, [parentPath(path)]),
    [run],
  );

  const paste = useCallback(async (dest: string) => {
    const clip = nodeClipboard.value;
    if (!clip || clip.paths.length === 0) return false;
    const ok = clip.mode === 'cut' ? await move(clip.paths, dest) : await copy(clip.paths, dest);
    if (ok && clip.mode === 'cut') nodeClipboard.value = null;
    return ok;
  }, [move, copy]);

  return { error, clearError: () => setError(null), busy, move, copy, rename, remove, mkdir, chmod, chown, paste };
}
