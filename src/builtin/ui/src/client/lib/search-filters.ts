/**
 * The search filter vocabulary, with nothing attached to it.
 *
 * Separate from useSearch so the URL codec can use it: the hook imports the WebSocket shell
 * client, which drags the whole browser runtime into anything that touches it. useSearch
 * re-exports all of this, so `@ein/ui/hooks` remains the place to import it from in components.
 *
 * The vocabularies are the `search` command's own.
 */

export const SEARCH_KINDS = ['photo', 'video', 'audio', 'document', 'person', 'location', 'album', 'device', 'track'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];

export const SEARCH_SORTS = ['score', 'time', '-time', 'name'] as const;
export type SearchSort = typeof SEARCH_SORTS[number];

/** Kinds that render as thumbnails; everything else stays a card. */
export const MEDIA_KINDS: ReadonlySet<string> = new Set<SearchKind>(['photo', 'video', 'audio']);

/** The kinds that are files rather than the things holding them. */
export const FILE_KINDS: readonly SearchKind[] = ['photo', 'video', 'audio', 'document'];

/**
 * The kinds a thing can be rather than a file. Which of them the Search page finds is the
 * installed modules' to say (`searchableKinds`).
 */
export const ENTITY_KINDS: readonly SearchKind[] = ['album', 'person', 'location', 'device', 'track'];

/**
 * The media page's type filter, as one exclusive choice rather than a set of
 * chips.
 *
 * Exclusive because that is how the question is actually asked — "just the
 * videos" — and because a chip set makes "none selected" mean the same as "all
 * selected", which then has to be explained.
 */
export type MediaKindFilter = { value: string; label: string; kinds: readonly SearchKind[] };

export const MEDIA_KIND_FILTERS: readonly MediaKindFilter[] = [
  { value: 'all', label: 'All', kinds: FILE_KINDS },
  { value: 'photo', label: 'Images', kinds: ['photo'] },
  { value: 'video', label: 'Video', kinds: ['video'] },
  { value: 'audio', label: 'Audio', kinds: ['audio'] },
  { value: 'document', label: 'Documents', kinds: ['document'] },
];

export type SearchRegion =
  | { shape: 'bbox'; north: number; south: number; east: number; west: number }
  | { shape: 'circle'; lat: number; lng: number; radius: number }
  | { shape: 'polygon'; points: { lat: number; lng: number }[] };

export type SearchFilters = {
  query?: string;
  kinds?: SearchKind[];
  tags?: string[];
  /** Inclusive year bounds; `to` covers the whole year (the command's --to is bucket-exclusive). */
  fromYear?: number;
  toYear?: number;
  region?: SearchRegion;
  /**
   * Media every one of these subjects has, each `<kind>:<slug or path>` as `search --subject`
   * takes it (`person:anna`, `location:…`, `device:/archive/devices/…`). Intersected.
   */
  subjects?: string[];
  /**
   * Each `<kind>:<words>` matches every subject of the kind whose name matches the words
   * (`search --subject-name`). Matches within one entry are unioned; repeated entries are
   * intersected ("Anna and Erik").
   */
  subjectNames?: string[];
  /** Media held by one album or directory, by path. Softlink members are followed. */
  under?: string;
  /**
   * Media anywhere in the tree under a directory, by path, however deep (`search --within`): a
   * place, not a membership, so softlinks are not followed. Listed by time, the undated after.
   */
  within?: string;
  /**
   * Only what lacks every one of these attrs, a nested one dotted (`search --missing`):
   * `duplicate.deferred` leaves out the staged exact copies that are not indexed.
   */
  missing?: string[];
  /**
   * Media that looks like this picture, by path (`search --like`): an archive file, or one put
   * in /tmp to search with. It ranks instead of `query`; the other filters narrow it.
   */
  like?: string;
  /**
   * Media created — uploaded or imported — by this user, by uid.
   *
   * The media page's "My" scope. A node column rather than an attr, which is
   * why it is a number here and `--creator` there: the command also takes a
   * username, but the UI already holds the uid from `user-whoami`.
   */
  creator?: number;
  sort?: SearchSort;
};

/** A subject as `search --subject` and `--subject-name` take it: `<kind>:<ref>`. */
export const subjectArg = (kind: string, ref: string): string => `${kind}:${ref}`;

/** A subject argument split at its first colon; a bare path has no kind. */
export const splitSubject = (arg: string): { kind?: string; ref: string } => {
  const at = arg.indexOf(':');
  return arg.startsWith('/') || at < 1 ? { ref: arg } : { kind: arg.slice(0, at), ref: arg.slice(at + 1) };
};

/** The refs among `args` of one kind. */
export const subjectRefs = (args: readonly string[] | undefined, kind: string): string[] =>
  (args ?? []).flatMap((arg) => {
    const split = splitSubject(arg);
    return split.kind === kind ? [split.ref] : [];
  });
