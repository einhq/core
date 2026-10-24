import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { buildSearchCommand, searchResultToMediaItem } from '../../hooks/useSearch.ts';

Deno.test('a score-ordered search never sends a time anchor', () => {
  const command = buildSearchCommand({ query: 'sailing boat', sort: 'score' }, 60, undefined, null);
  assertStringIncludes(command, '--sort score');
  assertFalse(command.includes('--at'));
});

Deno.test('subjects and partial names are sent as their own repeatable search facets', () => {
  const command = buildSearchCommand({ query: 'seglar', subjects: ['location:hamnen'], subjectNames: ['person:Nils', 'person:Maria'] }, 60);
  assertStringIncludes(command, "'seglar'");
  assertStringIncludes(command, "--subject 'location:hamnen' --subject-name 'person:Nils' --subject-name 'person:Maria'");
});

Deno.test('search result score reaches the media item overlay data', () => {
  const item = searchResultToMediaItem({
    path: '/media/boat.jpg',
    kind: 'photo',
    type: 'file',
    name: 'boat.jpg',
    mimetype: 'image/jpeg',
    score: 0.873,
    ownership: { mode: 0o750, uid: 3000, gid: 1002 },
  });
  assertEquals(item.score, 0.873);
  assertEquals(item.ownership, { mode: 0o750, uid: 3000, gid: 1002 });
});

Deno.test('the creator scope reaches the command as a uid', () => {
  const command = buildSearchCommand({ creator: 3000, kinds: ['photo'] }, 60);
  assertStringIncludes(command, '--kind photo --creator 3000');
});

Deno.test('the plain newest-first browse', () => {
  assertEquals(buildSearchCommand({ sort: '-time' }, 60, undefined, null), 'search -l 60 --fields description --sort -time');
});

Deno.test('an upward page sends the above token instead of a cursor or anchor', () => {
  const command = buildSearchCommand({ sort: '-time' }, 60, 'downward-cursor', '2008-01', false, 'abc,2008-01-15T10:00:00Z');
  assertStringIncludes(command, "--above 'abc,2008-01-15T10:00:00Z'");
  assertFalse(command.includes('--cursor'));
  assertFalse(command.includes('--at'));
});

Deno.test('a text search leaves what counts as a match to the search', () => {
  const command = buildSearchCommand({ query: 'sailing boat' }, 60);
  assertFalse(command.includes(' -t '));
});

Deno.test('a subtree is sent as --within, beside the time sort', () => {
  const command = buildSearchCommand({ within: '/home/anna/staging/files', sort: 'time' }, 60, undefined, null, true);
  assertStringIncludes(command, "--within '/home/anna/staging/files' --sort time");
  assertStringIncludes(command, '--layout');
});
