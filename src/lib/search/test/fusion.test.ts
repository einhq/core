import { assertEquals } from '@std/assert';
import { type Candidate, type ChannelHits, fuseChannels, rankChannel } from '../sources.ts';
import type { SearchRankChannel } from '../../api/search.ts';

const candidates = (...paths: string[]): Map<string, Candidate> => new Map(paths.map((path) => [path, { path, score: 0 }]));
const hits = (entries: [string, number][]): ChannelHits => new Map(entries.map(([path, score]) => [path, { score }]));

Deno.test('a channel ranks by its own score, path breaking ties', () => {
  assertEquals([...rankChannel(hits([['/b', 0.2], ['/c', 0.9], ['/a', 0.2]]))], [['/c', 1], ['/a', 2], ['/b', 3]]);
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
    ['authored', new Map([['/a', 1]])],
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
