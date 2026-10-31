/**
 * Shared helpers for VFS semantics tests.
 */

import type { Access } from '../../lib/access/mod.ts';
import type { LocalNodeVFS } from '../local-node-vfs.ts';
import type { NodeReference, NodeVFS } from '../mod.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function mkdir(vfs: NodeVFS, access: Access, parent: string, name: string, mode = 0o755) {
  return await vfs.create(access, 'directory', parent, name, { props: { mode } });
}

/**
 * Create every directory in an absolute path, parents first, so a test sets up
 * the layout `paths.ts` names rather than a name that happens to match.
 */
export async function mkdirp(vfs: NodeVFS, access: Access, path: string, mode = 0o755) {
  let parent = '/';
  for (const segment of path.split('/').filter(Boolean)) {
    const current = parent === '/' ? `/${segment}` : `${parent}/${segment}`;
    if (!(await vfs.exists(access, current))) await mkdir(vfs, access, parent, segment, mode);
    parent = current;
  }
  return parent;
}

export async function mkfile(vfs: NodeVFS, access: Access, parent: string, name: string, content: string, mode = 0o644) {
  const node = await vfs.create(access, 'file', parent, name, {
    props: { mode },
    attrs: { name, mimetype: 'text/plain', size: 0 },
  });

  const handle = await vfs.open(access, `${parent === '/' ? '' : parent}/${name}`, { mode: 'w' });
  try {
    await handle.write(enc.encode(content));
  } finally {
    await handle.close();
  }

  return node;
}

export async function readFile(vfs: NodeVFS, access: Access, ref: NodeReference): Promise<string> {
  const handle = await vfs.open(access, ref, { mode: 'r' });
  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await handle.read(64 * 1024);
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    return chunks.map((c) => dec.decode(c)).join('');
  } finally {
    await handle.close();
  }
}

/**
 * Attach a file to `dir` each time one of the next `times` subtree walks ends, in the window
 * between the subtree emptying and the node's own edge going.
 */
export function refillAfterReap(vfs: LocalNodeVFS, access: Access, dir: string, times: number): () => void {
  const target = vfs as unknown as { reapSubtrees: (...args: unknown[]) => Promise<void> };
  const reap = target.reapSubtrees;
  let left = times;
  target.reapSubtrees = async function (...args) {
    await reap.apply(this, args);
    if (left-- > 0) await mkfile(vfs, access, dir, `.profile${left}`, 'profile');
  };
  return () => {
    target.reapSubtrees = reap;
  };
}
