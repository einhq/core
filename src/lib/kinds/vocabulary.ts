/**
 * The content kinds themselves, import-free: `@ein/api` names them in answers the browser reads,
 * so this must not type-check core. `mod.ts` adds the store conditions.
 *
 * A file is one of the file kinds, told by its mimetype. Anything else is the kind its node type
 * names — `person`, `album`, `location` — so whatever node types the installed modules define are
 * kinds without core naming one of them.
 */

export const FILE_KINDS = ['photo', 'video', 'audio', 'document'] as const;
export type FileKind = typeof FILE_KINDS[number];

/** A file kind, or a node type. */
export type Kind = string;

/** Kinds that are files someone would call "my pictures". */
export const MEDIA_KINDS = new Set<Kind>(['photo', 'video', 'audio']);

/** The mimetype prefix a media kind is, where it is a prefix at all. */
export const MEDIA_KIND_PREFIX: Record<string, string> = {
  photo: 'image/',
  video: 'video/',
  audio: 'audio/',
};

export const isFileKind = (value: string): value is FileKind => (FILE_KINDS as readonly string[]).includes(value);

/** Whether a word can name a kind: a file kind, or what a node type may be called. */
export const isKind = (value: string): boolean => /^[a-z][a-z0-9-]*$/.test(value);
