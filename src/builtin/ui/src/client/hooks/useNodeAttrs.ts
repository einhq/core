import { useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import { runLimited } from '../lib/cover.ts';

// Session-lived, like the cover caches: a card re-entering the viewport, or a
// search re-run over the same hits, never asks twice.
const cache = new Map<string, Record<string, unknown>>();

/**
 * One node's attrs, fetched lazily.
 *
 * For callers that came from a listing this is waste — `ls -l` already returned
 * the whole attrs object. It is here for the ones that did not: a search hit
 * carries only a path, a name and (with `--fields description`) a description,
 * so the description snippet, labels and dates on its card have to be asked for.
 *
 * Gated on `enabled` (pass a viewport check) and queued behind the same
 * concurrency cap the cover loaders share, so a fast scroll through a page of
 * results cannot fan out into hundreds of shell commands.
 */
export function useNodeAttrs<T extends Record<string, unknown>>(
  path: string,
  enabled: boolean,
): { attrs?: T; loaded: boolean } {
  const [attrs, setAttrs] = useState<T | undefined>(() => cache.get(path) as T | undefined);

  useEffect(() => {
    if (attrs || !enabled || !path) return;
    let cancelled = false;

    runLimited(() => execCommand<T>(`attrs ${shq(path)}`)).then((found) => {
      const value = found ?? ({} as T);
      cache.set(path, value);
      if (!cancelled) setAttrs(value);
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [path, enabled, attrs]);

  return { attrs, loaded: attrs !== undefined };
}

/**
 * The `name` attr of each of a few nodes, by path, as they arrive — for labels that hold a node's
 * path or slug (a search's person and location chips). Shares `useNodeAttrs`'s cache and its cap.
 */
export function useNodeNames(paths: readonly string[]): Map<string, string> {
  const key = [...new Set(paths)].sort().join('\n');
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const wanted = key ? key.split('\n') : [];
    const nameOf = (attrs: Record<string, unknown> | undefined) => (typeof attrs?.name === 'string' ? attrs.name : undefined);
    const known = new Map(wanted.flatMap((path) => {
      const name = nameOf(cache.get(path));
      return name ? [[path, name] as const] : [];
    }));
    setNames(known);
    for (const path of wanted.filter((path) => !cache.has(path))) {
      runLimited(() => execCommand<Record<string, unknown>>(`attrs ${shq(path)}`)).then((found) => {
        cache.set(path, found ?? {});
        const name = nameOf(found);
        if (!cancelled && name) setNames((current) => new Map(current).set(path, name));
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return names;
}
