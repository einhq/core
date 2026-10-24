import { useCallback, useRef, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import { filtersFromMentions, type Mention, parseMentions } from '../lib/mentions.ts';
import { filtersFromNaturalQuery, type NaturalQueryParse } from '../lib/natural-search.ts';
import type { SearchFilters, SearchKind } from '../lib/search-filters.ts';

export type SearchBoxOptions = {
  /** The filters on screen — the URL's, on every page that has one. */
  filters: SearchFilters;
  /** Put filters on screen. Called once per pass that changed them. */
  apply: (next: SearchFilters) => void;
  /**
   * Read the words as natural language too (`parse-search`, which asks whichever module reads
   * them — the assistant's model): people, locations and years become
   * filters, the rest stays the description. Which kinds a parse may set; the page's own kind
   * control shows the rest.
   */
  natural?: { kinds: readonly SearchKind[] };
};

export type SearchBox = {
  /** The box's text: the description still to search for, plus what is being typed. */
  text: string;
  setText: (value: string) => void;
  /** Entities picked with `@`, remembered so the text can be matched back to them. */
  mentions: Mention[];
  setMentions: (mentions: Mention[]) => void;
  /** What `SearchInput` commits: the filters its mentions resolved to, and `@` runs that matched nothing. */
  commit: (next: SearchFilters, missed: string[]) => void;
  /**
   * Change filters outside the box — a chip removed, a control changed — dropping a parse still on
   * its way. Text edited but not yet committed is committed with the change.
   */
  patch: (changes: Partial<SearchFilters>) => void;
  /** Words that were meant as a person or a location and matched nothing, searched as words instead. */
  unresolved: string[];
  dismissUnresolved: () => void;
  /** The model is reading the words. The search already runs on the rules pass meanwhile. */
  parsing: boolean;
  /** The last parse the filters came from, for a page that explains its interpretation. */
  interpretation?: NaturalQueryParse;
};

/**
 * The search box's state, shared by every page that searches with one.
 *
 * Whatever the box understood leaves it: an `@` pick, and — with `natural` — a person, a location or a
 * year read from the words, becomes a filter the page shows as a chip (`SearchPills`), and the box
 * keeps only the words still searched as a description. A new commit adds to the chips rather than
 * replacing them, the way a second `@` pick does; a chip is removed by its own button.
 *
 * The natural-language read is two passes, because the search must not wait for the model: the
 * rules pass (years, kinds) answers in a round trip and the search runs on it at once; the model
 * pass then finds people and locations and re-applies only when it changed a filter. Anything the
 * reader does meanwhile — typing, removing a chip — drops the pass still on its way.
 */
export function useSearchBox({ filters, apply, natural }: SearchBoxOptions): SearchBox {
  const [text, setTextState] = useState(filters.query ?? '');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [interpretation, setInterpretation] = useState<NaturalQueryParse>();
  const generation = useRef(0);

  const drop = useCallback(() => {
    ++generation.current;
    setParsing(false);
  }, []);

  const setText = useCallback((value: string) => {
    drop();
    setTextState(value);
  }, [drop]);

  const commit = useCallback(async (next: SearchFilters, missed: string[]) => {
    const current = ++generation.current;
    const plain = next.query?.trim();
    setUnresolved(missed);
    if (!natural || !plain) {
      setParsing(false);
      setInterpretation(undefined);
      setTextState(plain ?? '');
      apply(next);
      return;
    }

    const read = (parsed: NaturalQueryParse): SearchFilters => filtersFromNaturalQuery(next, parsed, natural.kinds);
    setParsing(true);
    let applied: SearchFilters = next;
    try {
      try {
        const rules = await execCommand<NaturalQueryParse>(`parse-search --rules ${shq(plain)}`);
        if (current !== generation.current) return;
        applied = read(rules);
      } catch {
        // A broken shell connection must not take the plain word search down with it.
        if (current !== generation.current) return;
      }
      setTextState(applied.query ?? '');
      apply(applied);

      try {
        const parsed = await execCommand<NaturalQueryParse>(`parse-search ${shq(plain)}`);
        if (current !== generation.current) return;
        const refined = read(parsed);
        setInterpretation(parsed);
        setUnresolved([...new Set([...missed, ...parsed.unresolved])]);
        setTextState(refined.query ?? '');
        if (JSON.stringify(refined) !== JSON.stringify(applied)) apply(refined);
      } catch {
        // The command answers with its rules pass when the model cannot; if even that did not
        // arrive, the search already running on the rules pass stands.
      }
    } finally {
      if (current === generation.current) setParsing(false);
    }
  }, [apply, natural]);

  // The box is part of what is on screen: words edited since the last commit go along with the
  // change, or removing a chip would bring back a description the reader had already erased.
  const patch = useCallback((changes: Partial<SearchFilters>) => {
    const next = { ...filters, ...changes };
    if (text.trim() === (filters.query ?? '').trim()) {
      drop();
      apply(next);
      return;
    }
    const parsed = parseMentions(text, mentions);
    void commit(filtersFromMentions(next, parsed), parsed.unresolved);
  }, [drop, apply, commit, filters, text, mentions]);

  return {
    text,
    setText,
    mentions,
    setMentions,
    commit: (next, missed) => void commit(next, missed),
    patch,
    unresolved,
    dismissUnresolved: () => setUnresolved([]),
    parsing,
    interpretation,
  };
}
