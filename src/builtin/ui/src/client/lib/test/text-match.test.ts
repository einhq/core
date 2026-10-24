import { assertEquals } from '@std/assert';
import { foldText, matchesText, textScore } from '../text-match.ts';

Deno.test('case and accents aside', () => {
  assertEquals(foldText('Åsa Öberg-Ängel'), 'asa oberg angel');
  assertEquals(matchesText(['Åsa Öberg'], 'asa'), true);
  assertEquals(matchesText(['José'], 'JOSE'), true);
});

Deno.test('every word, in any order, across fields', () => {
  assertEquals(matchesText(['Anna Berg'], 'berg anna'), true);
  assertEquals(matchesText(['Anna Berg'], 'anna lind'), false);
  assertEquals(matchesText(['Canon EOS', 'Camera_One'], 'eos one'), true);
});

Deno.test('an empty query matches everything, missing fields match nothing', () => {
  assertEquals(matchesText(['Anna'], '   '), true);
  assertEquals(matchesText([undefined, null], 'x'), false);
});

Deno.test('textScore: the name counts most, every word must fit, letters in order are a last resort', () => {
  assertEquals(textScore('album-stack', [], 'album stack'), 100);
  assertEquals(textScore('album-stack', ['Stack similar photos'], 'photos') > 0, true);
  assertEquals(textScore('album-stack', ['Stack similar photos'], 'album') > textScore('album-cover', ['Pick an album cover'], 'stack'), true);
  assertEquals(textScore('album-stack', [], 'albstk') > 0, true);
  assertEquals(textScore('album-stack', ['Stack similar photos'], 'album person'), 0);
  assertEquals(textScore('ls', [], '   '), 0);
});
