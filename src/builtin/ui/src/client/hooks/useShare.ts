import { useCallback, useEffect, useState } from 'react';
import type { ShareDraft, ShareSaveOptions } from '../lib/share.ts';
import { buildFollowAllCommand, buildReferenceCommand, buildShareCommand } from '../lib/share.ts';
import { shq } from '../lib/shquote.ts';
import { execCommand } from '../signals/shell-client.ts';
import type { ShareInfo, ShareLinkCreated, ShareSetResult } from '@ein/api';
export type { EffectiveEntry, ShareInfo, ShareSetResult } from '@ein/api';

/** When a link stops working: epoch ms, or null for never. */
export type LinkExpiry = number | null;

/** The flag for an expiry; none for a new link left to the server's default. */
const expiryFlag = (expiry: LinkExpiry | undefined): string => (expiry === undefined ? '' : expiry === null ? ' --never' : ` --expires ${expiry}`);

type UseShareResult = {
  info: ShareInfo | null;
  /**
   * Bumped when `info` is read afresh as a whole — on opening and after a save — and not when only
   * its links or exceptions are: a draft resets on the first and survives the second.
   */
  revision: number;
  loading: boolean;
  error: Error | null;
  /** Send a draft; resolves with the counts so the caller can report them. */
  save: (draft: ShareDraft, opts?: ShareSaveOptions) => Promise<ShareSetResult>;
  /** Make a link; without an expiry it works for the server's default time. */
  createLink: (expiry?: LinkExpiry) => Promise<ShareLinkCreated>;
  setLinkExpiry: (id: string, expiry: LinkExpiry) => Promise<void>;
  removeLink: (id: string) => Promise<void>;
  /** Share nodes below this one as this one is, and let its changes reach them again. */
  shareLikeThis: (paths: string[]) => Promise<ShareSetResult>;
  /** Share every node below this one that keeps its own sharing as this one is, those not listed too. */
  shareAllLikeThis: () => Promise<ShareSetResult>;
  /** Share this node as `reference` is, and let changes from above reach it again. */
  shareLike: (reference: string) => Promise<ShareSetResult>;
};

/**
 * A node's sharing, read and written.
 *
 * `enabled` exists because the dialog is closed most of the time: mounting a
 * Share button on every album card should not cost a directory listing each.
 */
export function useShare(path: string | undefined, enabled = true): UseShareResult {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchInfo = useCallback(async () => {
    if (!path || !enabled) return;

    try {
      setLoading(true);
      setError(null);
      setInfo(await execCommand<ShareInfo>(`share-info ${shq(path)}`));
      setRevision((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  /** Read the links and the exceptions again, and nothing a draft is made from. */
  const refreshParts = useCallback(async () => {
    if (!path) return;
    const fresh = await execCommand<ShareInfo>(`share-info ${shq(path)}`);
    setInfo((current) => current && { ...current, links: fresh.links, exceptions: fresh.exceptions, exceptionCount: fresh.exceptionCount });
  }, [path]);

  const save = useCallback(async (draft: ShareDraft, opts?: ShareSaveOptions) => {
    if (!path) throw new Error('no node to share');
    const result = await execCommand<ShareSetResult>(buildShareCommand(path, draft, opts));
    await fetchInfo();
    return result;
  }, [path, fetchInfo]);

  const createLink = useCallback(async (expiry?: LinkExpiry) => {
    if (!path) throw new Error('no node to share');
    const created = await execCommand<ShareLinkCreated>(`share-link create ${shq(path)}${expiryFlag(expiry)}`);
    await refreshParts();
    return created;
  }, [path, refreshParts]);

  const setLinkExpiry = useCallback(async (id: string, expiry: LinkExpiry) => {
    await execCommand(`share-link set ${shq(id)}${expiryFlag(expiry)}`);
    await refreshParts();
  }, [refreshParts]);

  const removeLink = useCallback(async (id: string) => {
    await execCommand(`share-link remove ${shq(id)}`);
    await refreshParts();
  }, [refreshParts]);

  const shareLikeThis = useCallback(async (paths: string[]) => {
    if (!path) throw new Error('no node to share');
    const result = await execCommand<ShareSetResult>(buildReferenceCommand(paths, path));
    await refreshParts();
    return result;
  }, [path, refreshParts]);

  const shareAllLikeThis = useCallback(async () => {
    if (!path) throw new Error('no node to share');
    const result = await execCommand<ShareSetResult>(buildFollowAllCommand(path));
    await refreshParts();
    return result;
  }, [path, refreshParts]);

  const shareLike = useCallback(async (reference: string) => {
    if (!path) throw new Error('no node to share');
    const result = await execCommand<ShareSetResult>(buildReferenceCommand([path], reference));
    await fetchInfo();
    return result;
  }, [path, fetchInfo]);

  return { info, revision, loading, error, save, createLink, setLinkExpiry, removeLink, shareLikeThis, shareAllLikeThis, shareLike };
}

const parentOf = (path: string): string | undefined => {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : undefined;
};

/**
 * What a node that keeps its own sharing keeps it apart from: the node holding it, whose changes
 * no longer reach it. A plain folder directly inside a typed node — an album's `files` — is that
 * node's content, so a file in it is held by the album rather than by the folder. Null while
 * `enabled` is false or the read has not answered.
 */
export function useShareHolder(path: string, enabled: boolean): ShareInfo | null {
  const [holder, setHolder] = useState<ShareInfo | null>(null);

  useEffect(() => {
    setHolder(null);
    const parent = parentOf(path);
    if (!enabled || !parent) return;
    let cancelled = false;
    (async () => {
      const above = await execCommand<ShareInfo>(`share-info ${shq(parent)}`);
      const grandparent = parentOf(parent);
      if (above.type === 'directory' && grandparent) {
        const owner = await execCommand<ShareInfo>(`share-info ${shq(grandparent)}`);
        if (owner.type !== 'directory') return owner;
      }
      return above;
    })()
      .then((found) => !cancelled && setHolder(found))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return holder;
}
