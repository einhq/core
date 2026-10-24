import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityCompleteHit as EntityCompleteAnswer, EntityCompleteResult } from '@ein/api';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import { type Mention, MENTION_KINDS, type MentionKind } from '../lib/mentions.ts';
import { matchesText } from '../lib/text-match.ts';
import { useLabels } from './useLabels.ts';

/** How long the box stays still before a completion is asked for. */
const DEBOUNCE_MS = 150;

/** Suggestions shown at once. More than this is a list to read, not one to pick from. */
const LIMIT = 8;

export type EntityCompleteKind = Exclude<MentionKind, 'label'>;

/** One completion, of one of the kinds asked for. */
export type EntityCompleteHit = EntityCompleteAnswer & { kind: EntityCompleteKind };

/**
 * The value each kind's filter flag carries.
 *
 * A slug for a person or a location, which their subject commands resolve against
 * their root and which reads better in a URL; a whole path for the rest, because
 * `--under` resolves a path against the cwd.
 */
const valueOf = (kind: MentionKind, path: string): string => (kind === 'person' || kind === 'location' ? path.split('/').pop() ?? path : path);

export type UseMentionCompleteResult = {
  suggestions: Mention[];
  loading: boolean;
};

export type UseEntityCompleteResult = {
  hits: EntityCompleteHit[];
  loading: boolean;
};

/**
 * Cached entity completion for a plain text field.
 *
 * Unlike the full search command this reads only the small catalog roots. The
 * command caches those listings, so after the first debounced request each
 * keystroke only ranks names already held in memory.
 */
export function useEntityComplete(
  query: string | undefined,
  kinds: readonly EntityCompleteKind[],
): UseEntityCompleteResult {
  const [hits, setHits] = useState<EntityCompleteHit[]>([]);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const kindKey = kinds.join(',');

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    const trimmed = query?.trim() ?? '';
    if (query === undefined || !trimmed || !kindKey) {
      generationRef.current++;
      setHits([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const generation = ++generationRef.current;
      try {
        const resp = await execCommand<EntityCompleteResult & { results: EntityCompleteHit[] }>(
          `completion-entity ${shq(trimmed)} --kind ${kindKey} -l ${LIMIT}`,
        );
        if (generation !== generationRef.current) return;
        setHits(resp.results ?? []);
      } catch {
        if (generation !== generationRef.current) return;
        setHits([]);
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS) as unknown as number;

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [query, kindKey]);

  return { hits, loading };
}

/**
 * Entity suggestions for an `@`-run.
 *
 * One `completion-entity` per settled keystroke — a single command that runs one
 * indexed query per kind and matches names in the store process. It is not
 * `search`: a text search fans out to every provider that can answer, each in
 * its own subshell, and several embed the query with the model on the way, which
 * is far too slow for a popup. A completion wants names, not semantics.
 *
 * Labels are matched here rather than by the command, because a label is not a
 * node — it is a `/tags/<label>` directory of softlinks — and the list is
 * already in hand from `useLabels`.
 *
 * `query` of undefined means no run is open, which cancels rather than searches:
 * closing the popup must not leave a request in flight that reopens it.
 */
export function useMentionComplete(
  query: string | undefined,
  kinds: readonly MentionKind[] = MENTION_KINDS,
): UseMentionCompleteResult {
  const { labels } = useLabels();
  const kindKey = kinds.join(',');
  const remote = kinds.filter((kind): kind is EntityCompleteKind => kind !== 'label');
  const { hits, loading } = useEntityComplete(query, remote);

  const suggestions = useMemo((): Mention[] => {
    if (query === undefined) return [];

    const wanted = new Set(kindKey.split(',').filter(Boolean) as MentionKind[]);
    const needle = query.trim().toLowerCase();

    const local: Mention[] = wanted.has('label')
      ? labels
        .filter((entry) => matchesText([entry.label], needle))
        .map((entry) => ({ kind: 'label' as const, label: entry.label, value: entry.label }))
      : [];

    const remote: Mention[] = hits
      .filter((hit) => wanted.has(hit.kind))
      .map((hit) => ({ kind: hit.kind, label: hit.name, value: valueOf(hit.kind, hit.path) }));

    // An exactly-typed label leads; otherwise the entities lead, because the
    // command scored those properly and this side only substring-matched.
    const exact = local.filter((label) => label.value.toLowerCase() === needle);
    const rest = local.filter((label) => label.value.toLowerCase() !== needle);
    return [...exact, ...remote, ...rest].slice(0, LIMIT);
  }, [query, kindKey, hits, labels]);

  return { suggestions, loading: loading && suggestions.length === 0 };
}
