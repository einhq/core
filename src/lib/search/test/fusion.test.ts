import { assertEquals } from '@std/assert';
import { type Candidate, type ChannelHits, fuseChannels, rankChannel } from '../sources.ts';
import type { SearchRankChannel } from '../../api/search.ts';

const candidates = (...paths: string[]): Map<string, Candidate> => new Map(paths.map((path) => [path, { path, score: 0 }]));
const hits = (entries: [string, number][]): ChannelHits => new Map(entries.map(([path, score]) => [path, { score }]));

Deno.test('a channel ranks by its own score, path breaking ties', () => {
  assertEquals([...rankChannel(hits([['/b', 0.2], ['/c', 0.9], ['/a', 0.2]]))], [['/c', 1], ['/a', 2], ['/b', 3]]);
});

Deno.test('the paths ranked ahead lead the channel, by score among themselves', () => {
  const ranked = rankChannel(hits([['/a', 1], ['/b', 0.8], ['/c', 0.9]]), new Set(['/b', '/c']));
  assertEquals([...ranked], [['/c', 1], ['/b', 2], ['/a', 3]]);
});

Deno.test('scores on different scales meet only as ranks', () => {
  // A SigLIP2 cosine of 0.12 is a clear match; a text cosine of 0.8 is not more of one.
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['picture', rankChannel(hits([['/boat', 0.12], ['/dock', 0.1]]))],
    ['content', rankChannel(hits([['/dock', 0.8], ['/sea', 0.7]]))],
  ]);
  const fused = fuseChannels(candidates('/boat', '/dock', '/sea'), ranks);
  assertEquals(fused.map((candidate) => candidate.path), ['/dock', '/boat', '/sea']);
  assertEquals(fused[0].score, 1);
  assertEquals(fused[0].channels, { picture: 2, content: 1 });
});

Deno.test('a file two full channels agree on outranks one that leads a single channel', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['picture', new Map([['/one', 1], ['/both', 2]])],
    ['name', new Map([['/both', 2]])],
  ]);
  assertEquals(fuseChannels(candidates('/one', '/both'), ranks).map((candidate) => candidate.path), ['/both', '/one']);
});

Deno.test('equal fused scores order by path, so every page sees the same order', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['content', new Map([['/b', 1]])],
    ['transcript', new Map([['/a', 1]])],
  ]);
  assertEquals(fuseChannels(candidates('/b', '/a'), ranks).map((candidate) => candidate.path), ['/a', '/b']);
});

Deno.test('a name that only contains the query counts for less than the picture that leads', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['name', new Map([['/fyra.jpg', 1]])],
    ['picture', new Map([['/lighthouse.jpg', 1]])],
  ]);
  const partial = new Map([['name', hits([['/fyra.jpg', 0.5]])]] as const);
  assertEquals(fuseChannels(candidates('/fyra.jpg', '/lighthouse.jpg'), ranks, partial).map((candidate) => candidate.path), ['/lighthouse.jpg', '/fyra.jpg']);
  // The same name matched exactly is the answer, ahead of the picture.
  const exact = new Map([['name', hits([['/fyra.jpg', 1]])]] as const);
  assertEquals(fuseChannels(candidates('/fyra.jpg', '/lighthouse.jpg'), ranks, exact).map((candidate) => candidate.path), ['/fyra.jpg', '/lighthouse.jpg']);
});

Deno.test('an exact name alone leads a file the picture and its text both rank first', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['name', new Map([['/z-named.jpg', 1]])],
    ['picture', new Map([['/a-both.jpg', 1]])],
    ['content', new Map([['/a-both.jpg', 1]])],
  ]);
  const exact = new Map([['name', hits([['/z-named.jpg', 1]])]] as const);
  assertEquals(fuseChannels(candidates('/a-both.jpg', '/z-named.jpg'), ranks, exact).map((candidate) => candidate.path), ['/z-named.jpg', '/a-both.jpg']);
});

Deno.test('a hit its provider is confident of counts as a name, whatever its channel', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['transcript', new Map([['/speech.mp4', 1]])],
    ['picture', new Map([['/a.jpg', 1], ['/b.jpg', 2]])],
  ]);
  assertEquals(fuseChannels(candidates('/speech.mp4', '/a.jpg', '/b.jpg'), ranks).map((candidate) => candidate.path), ['/a.jpg', '/b.jpg', '/speech.mp4']);
  const confident = new Map([['transcript', new Map([['/speech.mp4', { score: 0.6, confident: true }]])]] as const);
  assertEquals(fuseChannels(candidates('/speech.mp4', '/a.jpg', '/b.jpg'), ranks, confident).map((candidate) => candidate.path), ['/speech.mp4', '/a.jpg', '/b.jpg']);
});

Deno.test('a picture with the words written in it leads pictures two channels found by similarity', () => {
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['picture', new Map([['/a.jpg', 1], ['/b.jpg', 2]])],
    ['content', new Map([['/letter.tif', 1], ['/c.jpg', 2], ['/b.jpg', 3]])],
  ]);
  const said = new Map([['content', new Map([['/letter.tif', { score: 1.2, confident: true }], ['/c.jpg', { score: 0.4 }], ['/b.jpg', { score: 0.3 }]])]] as const);
  assertEquals(fuseChannels(candidates('/a.jpg', '/b.jpg', '/c.jpg', '/letter.tif'), ranks, said).map((candidate) => candidate.path), [
    '/letter.tif',
    '/b.jpg',
    '/a.jpg',
    '/c.jpg',
  ]);
});

Deno.test('a person called what was asked leads a picture with their name written in it', () => {
  // The picture's path sorts first, so only the weights put the person ahead.
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['name', new Map([['/people/anna', 1]])],
    ['content', new Map([['/albums/invite.jpg', 1]])],
  ]);
  const said = new Map<'name' | 'content', ChannelHits>([
    ['name', hits([['/people/anna', 0.8]])],
    ['content', new Map([['/albums/invite.jpg', { score: 1.2, confident: true }]])],
  ]);
  assertEquals(fuseChannels(candidates('/albums/invite.jpg', '/people/anna'), ranks, said).map((candidate) => candidate.path), ['/people/anna', '/albums/invite.jpg']);
});

Deno.test('a person named alone leads their own media that a second channel also finds', () => {
  // The file named after her ties her name and sorts first; her pictures add `subject` to a picture
  // rank or a transcript the provider is confident of.
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['name', new Map([['/albums/anna andersson.jpg', 1], ['/people/anna andersson', 2]])],
    ['picture', new Map([['/albums/beach.jpg', 1], ['/albums/boat.jpg', 2]])],
    ['transcript', new Map([['/albums/speech.mp4', 1]])],
    ['subject', new Map([['/albums/anna andersson.jpg', 2], ['/albums/beach.jpg', 2], ['/albums/speech.mp4', 2]])],
  ]);
  const said = new Map<'name' | 'transcript', ChannelHits>([
    ['name', hits([['/albums/anna andersson.jpg', 1], ['/people/anna andersson', 1]])],
    ['transcript', new Map([['/albums/speech.mp4', { score: 0.9, confident: true }]])],
  ]);
  const paths = ['/albums/anna andersson.jpg', '/albums/beach.jpg', '/albums/boat.jpg', '/albums/speech.mp4', '/people/anna andersson'];
  const media = new Map([['/people/anna andersson', ['/albums/anna andersson.jpg', '/albums/beach.jpg', '/albums/speech.mp4']]]);
  const fused = fuseChannels(candidates(...paths), ranks, said, media);
  assertEquals(fused.map((candidate) => candidate.path), [
    '/people/anna andersson',
    '/albums/anna andersson.jpg',
    '/albums/speech.mp4',
    '/albums/beach.jpg',
    '/albums/boat.jpg',
  ]);
  assertEquals(fused[0].score, 1);
  // Without the subjects, the media lead her.
  assertEquals(fuseChannels(candidates(...paths), ranks, said)[0].path, '/albums/anna andersson.jpg');
});

Deno.test('a person named alone leads a picture with their name written in it that a picture rank also finds', () => {
  // By the weights alone the picture leads: 1.5 / (60 + 14) + 1 / (60 + 11) against 1.6 / 61.
  const ranks = new Map<SearchRankChannel, Map<string, number>>([
    ['name', new Map([['/people/anna andersson', 1], ['/people/anna berg', 2]])],
    ['content', new Map([['/albums/sign.jpg', 14], ['/albums/note.jpg', 15]])],
    ['picture', new Map([['/albums/beach.jpg', 1], ['/albums/sign.jpg', 11], ['/albums/note.jpg', 12]])],
  ]);
  const said = new Map<'name' | 'content', ChannelHits>([
    ['name', hits([['/people/anna andersson', 1], ['/people/anna berg', 0.8]])],
    ['content', new Map([['/albums/sign.jpg', { score: 1.2, confident: true }], ['/albums/note.jpg', { score: 1.2, confident: true }]])],
  ]);
  const paths = ['/albums/beach.jpg', '/albums/note.jpg', '/albums/sign.jpg', '/people/anna andersson', '/people/anna berg'];
  assertEquals(fuseChannels(candidates(...paths), ranks, said).map((candidate) => candidate.path), [
    '/people/anna andersson',
    '/people/anna berg',
    '/albums/sign.jpg',
    '/albums/note.jpg',
    '/albums/beach.jpg',
  ]);
  // Without a name confident enough to be the answer, the pictures keep their lead.
  const partial = new Map<'name' | 'content', ChannelHits>([['name', hits([['/people/anna andersson', 0.5], ['/people/anna berg', 0.5]])], ['content', said.get('content')!]]);
  assertEquals(fuseChannels(candidates(...paths), ranks, partial)[0].path, '/albums/sign.jpg');
});
