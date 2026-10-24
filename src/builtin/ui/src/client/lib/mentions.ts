/**
 * `@`-mentions in a search box, as a codec.
 *
 * The box holds a plain string — `sunglasses @Nils J Lund-Berg` — and
 * beside it a list of the entities that were actually picked from the
 * completion popup. Committing splits the two apart: the mentions become
 * filters (`--subject <kind>:…` for a person, a location or a device, `--tag`,
 * `--under`), and whatever text is left over is the free-text query.
 *
 * Why a string and a side-list rather than a rich editor: a mention label
 * contains spaces, so it cannot be delimited by whitespace, and there is no
 * unambiguous terminator to parse against. Remembering which runs were chosen
 * sidesteps the parsing problem entirely — and it degrades honestly, because a
 * `@foo` nobody chose stays visible as text and is reported rather than
 * silently dropped.
 *
 * A natural-language reading of the words (`parse-search`) may propose people and locations on
 * commit; what it resolves is written back into this same visible representation, so the codec
 * and the person typing remain the authority.
 *
 * Pure on purpose: no react, no shell client. Every round trip here is directly
 * testable, the same reason `search-params.ts` is separate.
 */

import { type SearchFilters, subjectArg, subjectRefs } from './search-filters.ts';

/** What an `@` can resolve to. Mirrors the `search` command's own kinds. */
export const MENTION_KINDS = ['person', 'location', 'label', 'device', 'album'] as const;
export type MentionKind = typeof MENTION_KINDS[number];

/** The mention kinds that are subjects, `--subject <kind>:<value>`; a label is a tag and an album a container. */
const SUBJECT_MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'device'];

export type Mention = {
  kind: MentionKind;
  /** What is shown after the `@`, and what is matched in the text. */
  label: string;
  /**
   * The value the filter carries.
   *
   * A slug for a person or location, a bare word for a label, and a full path for a
   * device or album — matching what each `search` flag expects.
   */
  value: string;
};

/** What committing a box produced. */
export type ParsedInput = {
  /** Everything that was not a mention, collapsed. */
  query: string;
  /** The mentions actually found in the text, in the order they appeared. */
  mentions: Mention[];
  /**
   * `@`-runs that match no known mention.
   *
   * Left in `query` as well as reported here: they are still words the user
   * typed, and searching for them beats pretending they were understood.
   */
  unresolved: string[];
};

/** A word after `@` — letters, digits, and the punctuation slugs use. */
const UNRESOLVED_RUN = /@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/**
 * Split a box's text into a query and the mentions inside it.
 *
 * Longest label first, so `@Anna Lindberg` is never consumed as `@Anna` with a
 * stray surname left behind. Matching is case-insensitive because the popup
 * writes the label but people retype it however they like.
 */
export const parseMentions = (text: string, known: readonly Mention[]): ParsedInput => {
  const ordered = [...known].sort((a, b) => b.label.length - a.label.length);
  const found: { mention: Mention; at: number }[] = [];

  let rest = text;
  for (const mention of ordered) {
    const token = `@${mention.label}`.toLowerCase();
    const at = rest.toLowerCase().indexOf(token);
    if (at < 0) continue;
    // Removed as it is found, so a second mention cannot match inside the first
    // one's label.
    rest = rest.slice(0, at) + rest.slice(at + token.length);
    found.push({ mention, at });
  }

  const unresolved = [...rest.matchAll(UNRESOLVED_RUN)].map((match) => match[1]);

  return {
    query: rest.replace(/\s+/g, ' ').trim(),
    // The order they appeared in, not the order they were stripped in.
    mentions: found.sort((a, b) => a.at - b.at).map((entry) => entry.mention),
    unresolved,
  };
};

/**
 * Fold mentions into a filter set.
 *
 * Merged with what is already there rather than replacing it, so a mention adds
 * to the visible controls instead of resetting them — and deduplicated, because
 * typing the same person twice is not "both of them".
 */
export const filtersFromMentions = (current: SearchFilters, parsed: ParsedInput): SearchFilters => {
  const add = (existing: string[] | undefined, values: string[]): string[] | undefined => {
    const merged = [...new Set([...(existing ?? []), ...values])];
    return merged.length > 0 ? merged : undefined;
  };

  const of = (kind: MentionKind) => parsed.mentions.filter((mention) => mention.kind === kind).map((mention) => mention.value);

  const subjects = add(current.subjects, SUBJECT_MENTION_KINDS.flatMap((kind) => of(kind).map((value) => subjectArg(kind, value))));
  const tags = add(current.tags, of('label'));
  // Single-valued in the command, so the last one mentioned wins.
  const under = of('album').at(-1) ?? current.under;

  return {
    ...current,
    query: parsed.query || undefined,
    ...(subjects ? { subjects } : {}),
    ...(tags ? { tags } : {}),
    ...(under ? { under } : {}),
  };
};

/**
 * Rebuild what the box should show for a filter set — the inverse of the two
 * functions above.
 *
 * This is what makes a shared link land with the search still legible: the URL
 * carries `subject=person:nils_j_lund`, and the box has to say
 * `@Nils J Lund-Berg` again. `label` looks a value up; returning
 * undefined drops that mention rather than showing a raw slug, since a slug in
 * the box would not re-parse to the same filter.
 */
export const textFromFilters = (
  filters: SearchFilters,
  label: (kind: MentionKind, value: string) => string | undefined,
): { text: string; mentions: Mention[] } => {
  const mentions: Mention[] = [];

  const push = (kind: MentionKind, values: (string | undefined)[]) => {
    for (const value of values) {
      if (!value) continue;
      const name = label(kind, value);
      if (name) mentions.push({ kind, label: name, value });
    }
  };

  for (const kind of SUBJECT_MENTION_KINDS) push(kind, subjectRefs(filters.subjects, kind));
  push('label', filters.tags ?? []);
  push('album', [filters.under]);

  const text = [filters.query?.trim(), ...mentions.map((mention) => `@${mention.label}`)].filter(Boolean).join(' ');
  return { text, mentions };
};

/**
 * The `@`-run the caret is sitting in, if any — what the popup completes on.
 *
 * A label can contain spaces, so the run does not stop at one: it runs from the
 * `@` to the caret, and the popup narrows as more is typed. It ends at
 * punctuation that never appears in a name, which is what lets a second mention
 * start on the same line.
 */
export const mentionAtCaret = (text: string, caret: number): { query: string; start: number } | undefined => {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return undefined;
  // `foo@bar` is an email, not a mention: an `@` only opens one at a boundary.
  if (at > 0 && !/\s/.test(before[at - 1])) return undefined;

  const query = before.slice(at + 1);
  if (/[,;:!?"'()[\]]/.test(query)) return undefined;
  return { query, start: at };
};

/** Replace the `@`-run at the caret with a chosen mention, and say where the caret goes. */
export const applyCompletion = (
  text: string,
  caret: number,
  run: { start: number },
  mention: Mention,
): { text: string; caret: number } => {
  const token = `@${mention.label} `;
  const next = text.slice(0, run.start) + token + text.slice(caret);
  return { text: next, caret: run.start + token.length };
};
