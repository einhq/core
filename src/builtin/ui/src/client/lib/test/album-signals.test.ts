import { assertEquals } from '@std/assert';
import { effect } from '@preact/signals-react';
import { mediaItemFrom } from '../media-item.ts';
import {
  albumMediaList,
  clearLightboxReturn,
  currentMediaIndex,
  currentMediaItem,
  endLightbox,
  goToNextMedia,
  goToPrevMedia,
  hasNextMedia,
  hasPrevMedia,
  lightboxReturnPath,
  nextMediaIndex,
  offerLightboxList,
  prevMediaIndex,
  showLightboxPath,
} from '../../signals/album.ts';

Deno.test('nextMediaIndex advances circularly only when another item exists', () => {
  assertEquals(nextMediaIndex(0, 3), 1);
  assertEquals(nextMediaIndex(2, 3), 0);
  assertEquals(nextMediaIndex(0, 1), 0);
});

Deno.test('forward lightbox navigation wraps from the last media to the first', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;

  try {
    albumMediaList.value = [mediaItemFrom({ path: '/one.jpg' }), mediaItemFrom({ path: '/two.jpg' })];
    currentMediaIndex.value = 1;

    assertEquals(hasNextMedia.value, true);
    goToNextMedia();
    assertEquals(currentMediaIndex.value, 0);
  } finally {
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});

Deno.test('forward lightbox navigation stays put when there is no other media', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;

  try {
    albumMediaList.value = [mediaItemFrom({ path: '/only.jpg' })];
    currentMediaIndex.value = 0;

    assertEquals(hasNextMedia.value, false);
    goToNextMedia();
    assertEquals(currentMediaIndex.value, 0);
  } finally {
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});

Deno.test('prevMediaIndex steps back circularly only when another item exists', () => {
  assertEquals(prevMediaIndex(2, 3), 1);
  assertEquals(prevMediaIndex(0, 3), 2);
  assertEquals(prevMediaIndex(0, 1), 0);
});

Deno.test('backward lightbox navigation wraps from the first media to the last', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;

  try {
    albumMediaList.value = [mediaItemFrom({ path: '/one.jpg' }), mediaItemFrom({ path: '/two.jpg' })];
    currentMediaIndex.value = 0;

    assertEquals(hasPrevMedia.value, true);
    goToPrevMedia();
    assertEquals(currentMediaIndex.value, 1);
  } finally {
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});

Deno.test('a lightbox route shows its file from the open list, or alone until a page offers its list', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;
  const grid = [mediaItemFrom({ path: '/one.jpg' }), mediaItemFrom({ path: '/two.jpg' }), mediaItemFrom({ path: '/three.jpg' })];

  try {
    // Opened from the grid, then the route moves to another of its files: the list stays.
    albumMediaList.value = grid;
    currentMediaIndex.value = 0;
    showLightboxPath('/three.jpg');
    assertEquals(albumMediaList.value, grid);
    assertEquals(currentMediaIndex.value, 2);

    // A reload: the file alone, and a list without it changes nothing.
    endLightbox(false);
    albumMediaList.value = [];
    showLightboxPath('/two.jpg');
    assertEquals(albumMediaList.value.map((item) => item.path), ['/two.jpg']);
    offerLightboxList([mediaItemFrom({ path: '/other.jpg' })]);
    assertEquals(albumMediaList.value.map((item) => item.path), ['/two.jpg']);
    offerLightboxList([]);

    // The page's list arrives with it: walked from there, and offered once.
    offerLightboxList(grid);
    assertEquals(albumMediaList.value, grid);
    assertEquals(currentMediaItem.value?.path, '/two.jpg');
    offerLightboxList([mediaItemFrom({ path: '/two.jpg' })]);
    assertEquals(albumMediaList.value, grid);

    // Its route gone, nothing is open, and the grid is asked to show where it was left.
    endLightbox(true);
    assertEquals(currentMediaIndex.value, -1);
    assertEquals(lightboxReturnPath.value, '/two.jpg');
    endLightbox(false);
    assertEquals(lightboxReturnPath.value, '/two.jpg');
  } finally {
    clearLightboxReturn('/two.jpg');
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});

Deno.test('a lightbox route opened after the page offered its list walks that list', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;
  const grid = [mediaItemFrom({ path: '/one.jpg' }), mediaItemFrom({ path: '/two.jpg' }), mediaItemFrom({ path: '/three.jpg' })];

  try {
    albumMediaList.value = [];
    currentMediaIndex.value = -1;
    offerLightboxList(grid);
    showLightboxPath('/three.jpg');
    assertEquals(albumMediaList.value, grid);
    assertEquals(currentMediaIndex.value, 2);

    // Withdrawn when the page goes: the next route opens its file alone.
    endLightbox(false);
    offerLightboxList([]);
    albumMediaList.value = [];
    showLightboxPath('/two.jpg');
    assertEquals(albumMediaList.value.map((item) => item.path), ['/two.jpg']);
  } finally {
    endLightbox(false);
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});

Deno.test('the current item moves straight to the file in the offered list, never through another', () => {
  const previousList = albumMediaList.value;
  const previousIndex = currentMediaIndex.value;
  const grid = [mediaItemFrom({ path: '/one.jpg' }), mediaItemFrom({ path: '/two.jpg' }), mediaItemFrom({ path: '/three.jpg' })];
  const seen: (string | undefined)[] = [];

  try {
    albumMediaList.value = [];
    currentMediaIndex.value = -1;
    offerLightboxList([]);
    showLightboxPath('/three.jpg');
    const stop = effect(() => {
      seen.push(currentMediaItem.value?.path);
    });
    offerLightboxList(grid);
    stop();
    assertEquals(currentMediaIndex.value, 2);
    assertEquals(seen.filter((path) => path !== '/three.jpg'), []);
  } finally {
    endLightbox(false);
    offerLightboxList([]);
    albumMediaList.value = previousList;
    currentMediaIndex.value = previousIndex;
  }
});
