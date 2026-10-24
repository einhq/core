import { DOCS_PATH } from '@ein/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import { type NodeChildEntry } from '../lib/node-entry.ts';

export type DocNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: DocNode[];
};

const MAX_DEPTH = 5;

function isDirLike(type: string): boolean {
  return type === 'directory' || type === 'album' || type === 'softlink';
}

// index.md first, then directories, then files — each alphabetical
function sortDocNodes(nodes: DocNode[]): DocNode[] {
  return nodes.sort((a, b) => {
    const ai = a.name === 'index.md' ? 0 : a.type === 'directory' ? 1 : 2;
    const bi = b.name === 'index.md' ? 0 : b.type === 'directory' ? 1 : 2;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

async function listDocs(path: string, depth: number): Promise<DocNode[]> {
  if (depth > MAX_DEPTH) return [];
  let entries: NodeChildEntry[];
  try {
    entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(path)}`);
  } catch {
    return [];
  }

  const nodes: DocNode[] = [];
  for (const entry of entries) {
    const childPath = `${path}/${entry.name}`;
    if (isDirLike(entry.node.type)) {
      const children = await listDocs(childPath, depth + 1);
      // Skip empty directories (nothing to show)
      if (children.length === 0) continue;
      nodes.push({ name: entry.name, path: childPath, type: 'directory', children });
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      nodes.push({ name: entry.name, path: childPath, type: 'file' });
    }
  }
  return sortDocNodes(nodes);
}

export type UseDocsResult = {
  tree: DocNode[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * Build the documentation tree under a docs root (default `/docs`), following
 * the per-module softlinks under `/docs/modules/*` transparently.
 */
export function useDocs(rootPath: string = DOCS_PATH): UseDocsResult {
  const [tree, setTree] = useState<DocNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchTree = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setTree(await listDocs(rootPath, 0));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setTree([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  return { tree, loading, error, refetch: fetchTree };
}
