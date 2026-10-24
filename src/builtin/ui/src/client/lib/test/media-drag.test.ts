import { assertEquals, assertStrictEquals } from '@std/assert';
import { endMediaDrag, holdMediaDrag, isMediaDrag, MEDIA_DRAG_MIME, mediaDrag, takeMediaDrag } from '../media-drag.ts';

const payload = {
  label: '2 groups · 31 photos',
  count: 31,
  groups: ['/home/anna/staging/albums/inbox/lake-weekend', '/home/anna/staging/albums/inbox/2019-06-15'],
  files: [],
  except: ['/home/anna/staging/files/inbox/IMG_0412.jpg'],
};

Deno.test('a drag carries a token, and the token gives back what it carries', () => {
  const token = holdMediaDrag(payload);
  assertEquals(mediaDrag.peek()?.token, token);
  assertStrictEquals(takeMediaDrag(token), payload);
  endMediaDrag();
  assertEquals(mediaDrag.peek(), null);
});

Deno.test('a token that is not the drag under way gives nothing', () => {
  const first = holdMediaDrag(payload);
  const second = holdMediaDrag({ ...payload, count: 3 });
  assertEquals(first === second, false);
  assertEquals(takeMediaDrag(first), null);
  assertEquals(takeMediaDrag(undefined), null);
  assertEquals(takeMediaDrag(''), null);
  assertEquals(takeMediaDrag(second)?.count, 3);
  endMediaDrag();
  assertEquals(takeMediaDrag(second), null);
});

Deno.test('a drag of pictures is told from others by its type alone', () => {
  assertEquals(isMediaDrag([MEDIA_DRAG_MIME, 'text/plain']), true);
  assertEquals(isMediaDrag(['Files']), false);
  assertEquals(isMediaDrag(['text/plain']), false);
});
