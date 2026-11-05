/**
 * The rules over the rendition table that the pages and the pipelines making renditions share: a
 * role's file is named after its box, and a picture gets every `cover` role of its kind and the
 * `contain` roles up to the first box it fits inside, which holds it at its own size. The table's
 * file is read leaving out what it gets wrong.
 */

import { assertEquals } from '@std/assert';
import { audioFileName, imageFileName, imageRolesOf, NO_RENDITIONS, type RenditionTable, storyboardFileName, videoFileName } from '../renditions.ts';
import { parseRenditionTable } from '../../media/renditions.ts';

const ALL = ['photo', 'video', 'audio'] as RenditionTable['image'][string]['kinds'];

const TABLE: RenditionTable = {
  image: {
    // Listed out of size order: the rule orders by box, not by the file.
    medium: { width: 1600, height: 1600, fit: 'contain', quality: 60, kinds: ALL },
    thumb: { width: 320, height: 320, fit: 'cover', quality: 55, kinds: ALL },
    grid: { width: 512, height: 512, fit: 'contain', quality: 58, kinds: ALL },
    small: { width: 800, height: 800, fit: 'contain', quality: 60, kinds: ALL },
    large: { width: 2560, height: 2560, fit: 'contain', quality: 60, kinds: ['photo'] },
  },
  video: {},
  audio: {},
};

Deno.test('a picture gets the contain roles up to the first box it fits inside, and every cover role', () => {
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 600, height: 400 }), ['thumb', 'grid', 'small']);
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 400, height: 300 }), ['thumb', 'grid']);
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 800, height: 800 }), ['thumb', 'grid', 'small']);
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 801, height: 600 }), ['thumb', 'grid', 'small', 'medium']);
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 4000, height: 3000 }), ['thumb', 'grid', 'small', 'medium', 'large']);
  // A portrait fits by its long side.
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 400, height: 1000 }), ['thumb', 'grid', 'small', 'medium']);
  // The square crop enlarges to fill its box, so even a tiny picture has it.
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 100, height: 80 }), ['thumb', 'grid']);
});

Deno.test('a kind gets only the roles made of it, and without a size every one of them', () => {
  assertEquals(imageRolesOf(TABLE, 'video', { width: 4000, height: 3000 }), ['thumb', 'grid', 'small', 'medium']);
  assertEquals(imageRolesOf(TABLE, 'photo'), ['thumb', 'grid', 'small', 'medium', 'large']);
  assertEquals(imageRolesOf(TABLE, 'photo', { width: 0, height: 0 }), ['thumb', 'grid', 'small', 'medium', 'large']);
  assertEquals(imageRolesOf(NO_RENDITIONS, 'photo'), []);
});

Deno.test("a role's file is named after its box", () => {
  assertEquals(imageFileName(TABLE.image.thumb), '320x320.avif');
  assertEquals(videoFileName({ width: 1920, height: 1080 }), '1920x1080.mp4');
  assertEquals(audioFileName({ bitrate: '128k', sampleRate: 44100 }), '128k-44100.m4a');
  assertEquals(storyboardFileName({ tile: 160 }), 'storyboard-160.avif');
});

Deno.test('the file is read by section and role, the kinds defaulting to every one', () => {
  const read = parseRenditionTable(`
image:
  thumb: { width: 320, height: 320, fit: cover, quality: 55 }
  large: { width: 2560, height: 2560, fit: contain, quality: 60, kinds: [photo] }
video:
  preview: { width: 480, height: 480, crf: 36, preset: 10, start: 1, seconds: 20, mute: true }
  playback: { width: 1920, height: 1080, crf: 32, preset: 8, audioBitrate: 128k }
audio:
  playback: { bitrate: 128k, sampleRate: 44100 }
storyboard: { tile: 160, columns: 12, maxTiles: 240, minInterval: 1, quality: 55 }
`);
  assertEquals(read.warnings, []);
  assertEquals(read.table, {
    image: {
      thumb: { width: 320, height: 320, fit: 'cover', quality: 55, kinds: ['photo', 'video', 'audio'] },
      large: { width: 2560, height: 2560, fit: 'contain', quality: 60, kinds: ['photo'] },
    },
    video: {
      preview: { width: 480, height: 480, crf: 36, preset: 10, start: 1, seconds: 20, mute: true },
      playback: { width: 1920, height: 1080, crf: 32, preset: 8, audioBitrate: '128k' },
    },
    audio: { playback: { bitrate: '128k', sampleRate: 44100 } },
    storyboard: { tile: 160, columns: 12, maxTiles: 240, minInterval: 1, quality: 55 },
  });
});

Deno.test('what the file gets wrong is left out with a warning, and the rest kept', () => {
  const read = parseRenditionTable(`
image:
  thumb: { width: 320, height: 320, fit: cover, quality: 55 }
  grid: { width: 512, height: 512, fit: stretch, quality: 58 }
  small: { width: 0, height: 800, fit: contain, quality: 60 }
  medium: { width: 1600, height: 1600, fit: contain, quality: 60, kinds: [photo, film] }
video: nothing
audio:
  playback: { bitrate: 128 }
storyboard: { tile: 160 }
`);
  assertEquals(Object.keys(read.table.image), ['thumb']);
  assertEquals(read.table.video, {});
  assertEquals(read.table.audio, {});
  assertEquals(read.table.storyboard, undefined);
  assertEquals(read.warnings, [
    'image.grid: needs fit: cover or contain',
    'image.small: needs a width and a height above 0',
    'image.medium: kinds must be a list of photo, video, audio',
    'video: not a list of roles',
    'audio.playback: needs a bitrate, such as 128k, and a sampleRate',
    'storyboard: needs a tile, columns, maxTiles and minInterval above 0, and a quality',
  ]);
});

Deno.test('a file that is not a table is no renditions, and an empty one says nothing', () => {
  assertEquals(parseRenditionTable('image: [').table, NO_RENDITIONS);
  assertEquals(parseRenditionTable('image: [').warnings.length, 1);
  assertEquals(parseRenditionTable('- thumb').warnings, ['not a table of renditions']);
  assertEquals(parseRenditionTable(''), { table: NO_RENDITIONS, warnings: [] });
});
