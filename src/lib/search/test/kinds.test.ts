/**
 * The content-kind vocabulary: what `classify` calls a node, which node types a
 * kind narrows a store query to, and which kinds carry no capture time.
 *
 * A file's kind is its mimetype's; any other node's is its type, so the kinds a
 * module brings need no word of core's.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { classify, FILE_KINDS, isKind, isTimeless, kindNodeTypes, MEDIA_KINDS } from '../filters.ts';

Deno.test('kinds: a file is told by its mimetype', () => {
  assertEquals(classify('file', 'image/jpeg'), 'photo');
  assertEquals(classify('file', 'video/mp4'), 'video');
  assertEquals(classify('file', 'audio/mpeg'), 'audio');
  assertEquals(classify('file', 'application/pdf'), 'document');
});

Deno.test('kinds: any other node is the kind its type names', () => {
  assertEquals(classify('person', undefined), 'person');
  assertEquals(classify('location', undefined), 'location');
  assertEquals(classify('track', undefined), 'track');
  assertEquals(classify('sailboat', undefined), 'sailboat');
});

Deno.test('kinds: an unrecognised mimetype is no kind at all', () => {
  // Renditions and odd files fall out here rather than becoming results.
  assertEquals(classify('file', 'application/octet-stream'), undefined);
  assertEquals(classify('file', undefined), undefined);
});

Deno.test('kinds: a kind narrows to its node type, and every file kind to files', () => {
  for (const kind of FILE_KINDS) assertEquals(kindNodeTypes([kind]), ['file']);
  assertEquals(kindNodeTypes(['device', 'track']), ['device', 'track']);
  assertEquals(kindNodeTypes(['photo', 'video', 'location']), ['file', 'location']);
});

Deno.test('kinds: timeless means the store cannot order it by capture time', () => {
  // Only files have a takenAt, and orderBy drops rows missing the ordering attr, so
  // a time-ordered browse of anything else would return nothing at all.
  assert(isTimeless(['album']));
  assert(isTimeless(['person', 'location', 'device', 'track']));
  assertFalse(isTimeless(['photo']));
  // Mixed is not timeless: the media half does have a time to order on.
  assertFalse(isTimeless(['album', 'photo']));
  // No kinds at all is a whole-corpus timeline, not a timeless browse.
  assertFalse(isTimeless([]));
});

Deno.test('kinds: a kind is a word a node type may be', () => {
  assert(isKind('photo'));
  assert(isKind('media-region'));
  assertFalse(isKind('Photo'));
  assertFalse(isKind('a b'));
  assertFalse(isKind(''));
});

Deno.test('kinds: media kinds are the ones a person calls "my pictures"', () => {
  // What decides whether a text search also pulls in the media of a person it
  // matched: asking for albums should not drag in every photo of them.
  assert(MEDIA_KINDS.has('photo'));
  assert(MEDIA_KINDS.has('video'));
  assert(MEDIA_KINDS.has('audio'));
  assertFalse(MEDIA_KINDS.has('document'));
  assertFalse(MEDIA_KINDS.has('album'));
});
