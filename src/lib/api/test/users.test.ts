/** The username a new account is offered from a name and an e-mail address. */

import { assertEquals } from '@std/assert';
import { accountNameProblem, suggestUsername, usernameCandidates } from '../users.ts';

const first = (name: string, email = '', count = 4): string[] => {
  const out: string[] = [];
  for (const candidate of usernameCandidates(name, email)) {
    out.push(candidate);
    if (out.length === count) break;
  }
  return out;
};

Deno.test('the first name, then with the capitals of the last name, then numbered', () => {
  assertEquals(first('Anna Berg-Andersson'), ['anna', 'annaba', 'anna2', 'anna3']);
  assertEquals(first('Anna Maria Andersson'), ['anna', 'annaa', 'anna2', 'anna3']);
  assertEquals(first('anna berg'), ['anna', 'annab', 'anna2', 'anna3']);
  assertEquals(first('Anna'), ['anna', 'anna2', 'anna3', 'anna4']);
});

Deno.test('accents are dropped and only letters and digits of the name are kept', () => {
  assertEquals(first('Åsa Öberg', '', 2), ['asa', 'asao']);
  assertEquals(first('Per-Olof Säll', '', 2), ['perolof', 'perolofs']);
});

Deno.test('without a name, the part of the address before @ stands in', () => {
  assertEquals(first('', 'Anna.Berg@example.com', 2), ['annaberg', 'annaberg2']);
  assertEquals(first('', '', 1), []);
  assertEquals(first('', '2024@example.com', 1), []);
});

Deno.test('every candidate is an account name', () => {
  for (const name of ['Anna Berg-Andersson', 'Åsa Öberg', '  Bo   Ek  ', 'Ζωή Παπά']) {
    for (const candidate of first(name, '', 3)) assertEquals(accountNameProblem(candidate), undefined, candidate);
  }
});

Deno.test('the first candidate nothing has taken', () => {
  const taken = new Set(['anna', 'annaba', 'anna2']);
  assertEquals(suggestUsername('Anna Berg-Andersson', '', (name) => taken.has(name)), 'anna3');
  assertEquals(suggestUsername('Anna Berg-Andersson', '', () => false), 'anna');
  assertEquals(suggestUsername('', '', () => false), undefined);
});
