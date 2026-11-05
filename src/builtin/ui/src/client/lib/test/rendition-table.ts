/** A rendition table for the tests of the pages' rendition helpers: the sizes an installation ships. */

import type { RenditionTable } from '@ein/api';

export const TEST_RENDITIONS: RenditionTable = {
  image: {
    thumb: { width: 320, height: 320, fit: 'cover', quality: 55, kinds: ['photo', 'video', 'audio'] },
    grid: { width: 512, height: 512, fit: 'contain', quality: 58, kinds: ['photo', 'video', 'audio'] },
    small: { width: 800, height: 800, fit: 'contain', quality: 60, kinds: ['photo', 'video', 'audio'] },
    medium: { width: 1600, height: 1600, fit: 'contain', quality: 60, kinds: ['photo', 'video', 'audio'] },
    large: { width: 2560, height: 2560, fit: 'contain', quality: 60, kinds: ['photo'] },
  },
  video: {
    preview: { width: 480, height: 480, crf: 36, preset: 10, start: 1, seconds: 20, mute: true },
    playback: { width: 1920, height: 1080, crf: 32, preset: 8, audioBitrate: '128k' },
  },
  audio: { playback: { bitrate: '128k', sampleRate: 44100 } },
  storyboard: { tile: 160, columns: 12, maxTiles: 240, minInterval: 1, quality: 55 },
};
