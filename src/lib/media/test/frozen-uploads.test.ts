import { assertEquals } from '@std/assert';
import { freezes, parseFrozenUploads } from '../frozen-uploads.ts';

Deno.test('frozen-uploads: a line takes a type in, a ! line leaves it out', () => {
  const policy = parseFrozenUploads('# photos\nimage/*  # every picture\n!image/svg+xml\n\nVIDEO/MP4\n!\n');
  assertEquals(policy, { include: ['image/*', 'video/mp4'], exclude: ['image/svg+xml'] });

  assertEquals(freezes(policy, 'image/jpeg'), true);
  assertEquals(freezes(policy, 'Image/HEIC'), true);
  assertEquals(freezes(policy, 'video/mp4; codecs=avc1'), true);
  assertEquals(freezes(policy, 'image/svg+xml'), false);
  assertEquals(freezes(policy, 'video/quicktime'), false);
  assertEquals(freezes(policy, 'imagex/png'), false);
  assertEquals(freezes(policy, undefined), false);
  assertEquals(freezes(parseFrozenUploads(''), 'image/jpeg'), false);
});

Deno.test('frozen-uploads: the seed freezes media and leaves text, scripts and documents writable', async () => {
  const policy = parseFrozenUploads(await Deno.readTextFile(new URL('../../../builtin/core/etc/frozen-uploads', import.meta.url)));

  for (const type of ['image/jpeg', 'image/heic', 'image/x-canon-cr2', 'video/mp4', 'video/quicktime', 'audio/mpeg']) {
    assertEquals(freezes(policy, type), true, type);
  }
  for (const type of ['image/svg+xml', 'text/plain', 'text/markdown', 'application/json', 'application/rdf+xml', 'application/pdf', 'application/x-sh']) {
    assertEquals(freezes(policy, type), false, type);
  }
});
