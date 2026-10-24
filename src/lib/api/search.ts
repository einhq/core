/**
 * What `search` answers with: a page of hits, the facet counts (`--facets`), the groups holding
 * the hits (`--group-by`), or the complete compact layout of a container or subject (`--layout`).
 */

import type { Kind } from '../kinds/vocabulary.ts';
import type { NodeOwnership } from './ids.ts';

export type LayoutMediaKind = 'photo' | 'video' | 'audio';

export type LayoutIndexItem = {
  path: string;
  memberPath?: string;
  name: string;
  kind: LayoutMediaKind;
  mimetype?: string;
  takenAt?: string;
  width?: number;
  height?: number;
  angle?: number;
  duration?: number;
  stackCount?: number;
  /** Pixel aspect ratio of the stored raster; only an anamorphic video carries one. */
  sar?: number;
  /** Who may change the file. */
  ownership: NodeOwnership;
  /** It keeps its own sharing (`share-set --pin`), which a change to a folder above does not reach. */
  pinned?: boolean;
  /**
   * Whether the file has renditions (a `thumbnails/` child). Read only when asked for
   * (`--fields derivatives`), and absent otherwise.
   */
  hasDerivatives?: boolean;
};

/**
 * [pathDir, basename, memberDir|-1, memberName|'', displayName|'', kind,
 *  mimetype, takenAt|'', width|0, height|0, angle|0, duration|0, stackCount|0, sar|0, ownership,
 *  pinned 1|0]
 *
 * New fields are **appended**, never inserted: the decoder is a duplicate in the browser shell
 * (`lib/search-layout.ts` there) and a bundle can be one deploy behind the server it talks to. An
 * older decoder then ignores a trailing field, where a shifted one would silently read a
 * duration as an angle. A field only some answers carry is a list of its own beside the rows
 * (`SearchLayoutIndex.derivatives`), which an older decoder ignores the same way.
 */
export type LayoutIndexRow = [
  pathDir: number,
  basename: string,
  memberDir: number,
  memberName: string,
  displayName: string,
  kind: number,
  mimetype: number,
  takenAt: string,
  width: number,
  height: number,
  angle: number,
  duration: number,
  stackCount: number,
  sar: number,
  ownership: number,
  pinned: number,
];

export type SearchLayoutIndex = {
  directories: string[];
  mimetypes: string[];
  /** The distinct ownerships, which a row names by index: a container's files mostly share one. */
  ownerships: NodeOwnership[];
  items: LayoutIndexRow[];
  /**
   * With `--fields derivatives`: per row, in row order, 1 when its file has renditions (a
   * `thumbnails/` child) and 0 while it has none, so a grid draws a placeholder for a file not
   * processed yet instead of asking for renditions that are not there. A list of its own beside
   * the rows, since only an answer that was asked for it carries it.
   */
  derivatives?: number[];
};

export type SearchLayoutResponse = {
  truncated: boolean;
  cursor: null;
  offset: 0;
  layout: SearchLayoutIndex;
};

export type SearchHit = {
  path: string;
  /**
   * The softlink inside `--under` that makes this a member, when the container
   * links its media rather than holding it (a file added to an album).
   *
   * Both identities are reported because they answer different questions:
   * `path` is the file, `memberPath` is its membership. Removing a photo from
   * such an album means unlinking this — deleting `path` destroys the photo.
   */
  memberPath?: string;
  kind?: Kind;
  type: string;
  name: string;
  mimetype?: string;
  takenAt?: string;
  /** The instant, for ordering and for feeding this hit back in as a candidate. */
  takenAtUtc?: string;
  /**
   * How well it matched, relative to the best hit of this answer (1). A text search fuses the
   * channels by rank, so the number orders the answer and says nothing on its own.
   */
  score: number;
  /** With `--fields channels`: the hit's rank in each channel that found it (1 is first). */
  channels?: Partial<Record<SearchRankChannel, number>>;
  lat?: number;
  lng?: number;
  width?: number;
  height?: number;
  angle?: number;
  /** Pixel aspect ratio of that raster; only an anamorphic video carries one. */
  sar?: number;
  duration?: number;
  stackCount?: number;
  description?: string;
  /**
   * Seconds into an audio or video file where the words that matched are said, when its
   * transcript is one of the channels that found it. Lets a caller open at those words.
   */
  atSeconds?: number;
  /** Who may change the file, so a caller offers only what the reader may do to it. */
  ownership: NodeOwnership;
  /** Present when it keeps its own sharing (`share-set --pin`): a change to a folder above does not reach it. */
  pinned?: true;
};

/**
 * What a text hit was found by. Each channel's scores are on a scale of its own, so `search` only
 * ever compares hits within one channel, by rank, and fuses the ranks across channels.
 *
 * - `name`: what a thing is called — a file name, a person's, an album's (exact, prefix, substring).
 * - `description`: words in a node's own written description, matched as text.
 * - `authored`: a hand-written description, by meaning.
 * - `content`: text inside a file — a document's, or what is written in a picture.
 * - `transcript`: what is said in a recording.
 * - `picture`: what a picture or a video's frames show.
 * - `members`: what the pictures a node holds show — an album's, pooled from their `picture` scores.
 */
export type SearchChannel = 'name' | 'description' | 'authored' | 'content' | 'transcript' | 'picture' | 'members';

/** The channels a hit's rank is reported in: a provider's, and `subject`, the media of a subject whose name matched. */
export type SearchRankChannel = SearchChannel | 'subject';

/**
 * One row of a `search-*` provider's JSON answer: one hit in one channel. A provider that found
 * the same node by two channels answers two rows, and keeps at most `-l` rows per channel.
 */
export type SearchProviderHit = {
  path: string;
  type: string;
  name: string;
  channel: SearchChannel;
  /** On the channel's own scale, higher is better; only ever compared within the channel. */
  score: number;
  /**
   * The provider is sure of this hit on its channel's scale, which only it knows: `search` weighs
   * it as it weighs a name, whatever its channel's weight.
   */
  confident?: boolean;
  /** The node's id, when the provider holds it: `search` then loads a page of hits in one batch. */
  id?: string;
  description?: string;
  /** The wall clock and the instant, when the provider knows them. */
  takenAt?: string;
  takenAtUtc?: string;
  /** Seconds into a recording where a `transcript` match is. */
  atSeconds?: number;
};

/** A `search-*` provider's JSON answer; `truncated` when some channel had more than it answered. */
export type SearchProviderResponse = { results: SearchProviderHit[]; truncated?: boolean };

/** What `--group-by` reports per group — a container, or a subject the hits have. `from`/`to` span only the matching media. */
export type GroupTally = { path: string; type: string; name: string; count: number; from?: string; to?: string };

/** The filters `search` applied, echoed back so a caller can show what was understood. */
export type SearchAppliedFilters = {
  kinds: string[];
  tags: string[];
  from: string | null;
  to: string | null;
  region: unknown;
  /** The uid of the person who put the files in, when filtered on. */
  creator: number | null;
  /** Each `--subject`, as the node it resolved to. */
  subjects: { kind: string; path: string }[];
  /** Each `--subject-name`, and every subject it matched. */
  subjectNames: { kind: string; query: string; matches: string[]; truncated: boolean }[];
  under: string | null;
  /** The subtree `--within` listed, resolved to an absolute path. */
  within: string | null;
  /** The attrs every answer lacks (`--missing`), as named. */
  missing: string[];
  /** The picture `--like` ranked by, resolved to an absolute path. */
  like: string | null;
  sort: string;
  /** A date lifted out of the query text, when one was. */
  dateFromQuery: unknown;
};

/** A page of `search` hits. */
export type SearchResponse = {
  query: string;
  /** Wall time the command took on the server. */
  elapsedMs: number;
  /** What the providers said on stderr — a content match that timed out, say. Each degrades the answer. */
  warnings: readonly string[];
  filters: SearchAppliedFilters;
  /** The answer is a prefix of the real one — a scan limit was hit, or a text provider had more than it answered. */
  truncated: boolean;
  /** Resume token for the next page; null at the end, and always null for an upward page. */
  cursor: string | null;
  /** Resume token positioned at the top of this page, for the time-ordered browse that pages by key. */
  above: string | null;
  /** How many leading results sit above a seek; 0 when the page starts where it was asked to. */
  anchorIndex: number;
  /** Where this page starts in the answer, for the sources that page by position. */
  offset: number;
  results: SearchHit[];
};

/** `search --facets`: counts over everything that passed, dated or not. */
export type SearchFacetsResponse = {
  total: number;
  range: { min: number; max: number } | null;
  days: { key: string; count: number }[];
  months: { key: string; count: number }[];
  years: { year: number; count: number }[];
  /** What the answer is made of; need not sum to `total`, since not every node is a media kind. */
  kinds: { kind: string; count: number }[];
  /** The labels the answer's members carry, the most carried first, at most twenty. */
  labels: { label: string; count: number }[];
  /** A limit was reached somewhere: `total` is a floor, not a count. */
  truncated: boolean;
};

/** `search --group-by`: the groups holding the hits, and how many each holds. */
export type SearchGroupsResponse = {
  total: number;
  groups: GroupTally[];
  /** With a kind of subject: how many hits show a subject nobody has named yet — pictures, not people. */
  unnamed?: number;
  truncated: boolean;
};

/** A box: what a parsed location or a `--region` covers. */
export type SearchParseRegion = { shape: 'bbox'; north: number; south: number; east: number; west: number };

/** One subject a name matched: its name, and the ref `--subject <kind>:<ref>` takes. */
export type SearchSubjectMatch = { name: string; ref: string };

/**
 * A subject the words named — a person, a location node: `ref` when it is one subject, otherwise
 * every subject of the kind the name matches (`--subject-name <kind>:<name>`).
 */
export type SearchSubjectRef = { kind: string; name: string; ref?: string; matches: SearchSubjectMatch[] };

/**
 * `parse-search`: a search's words read as filters — subjects, an area, years, kinds — by the
 * command `CFG_SEARCH_PARSER` names (archive's `archive-parse`), or the words as they
 * are when none does. `source` says which pass answered; `--rules` asks for the fast one only.
 */
export type SearchParse = {
  /** What the pictures should show, for the semantic search; empty when nothing is left. */
  text: string;
  kinds: string[];
  from?: string;
  to?: string;
  subjects: SearchSubjectRef[];
  /** An area the words named — a country, a town: `search` takes a single box. */
  region?: SearchParseRegion;
  /** Names that matched nothing, searched as words instead. */
  unresolved: string[];
  source: 'llm' | 'rules' | 'none';
  /** A one-line account of the filters, written from what resolved rather than what was proposed. */
  explain: string;
};
