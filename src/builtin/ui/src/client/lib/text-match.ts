/**
 * How a list filter or a picker matches what was typed: one rule for every one of them.
 *
 * Case and accents aside — "asa" finds Åsa, "jose" José — and every word typed, in any order:
 * "berg anna" finds Anna Berg. Hyphens and underscores are spaces, so a double-barrelled name
 * or a slug matches its parts. Pure, so it is tested directly.
 */

/** Lowercase, accents stripped, `-` and `_` as spaces. */
export const foldText = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('sv').replace(/[-_]+/g, ' ');

/** The words of a query, folded. Empty for a query that is only spaces. */
export const queryWords = (query: string): string[] => foldText(query).split(/\s+/).filter(Boolean);

/** True when every word of `query` occurs somewhere in `fields`. An empty query matches everything. */
export const matchesText = (fields: readonly (string | undefined | null)[], query: string): boolean => {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const haystack = foldText(fields.filter(Boolean).join(' '));
  return words.every((word) => haystack.includes(word));
};

/** `word`'s letters appear in `text` in order, not necessarily together: "albstk" in "album stack". */
const isSubsequence = (word: string, text: string): boolean => {
  let at = 0;
  for (const char of text) {
    if (char === word[at]) at++;
    if (at === word.length) return true;
  }
  return false;
};

/**
 * How well `query` fits something called `name` and described by `fields`, for ranking a
 * search: 0 when some word of the query fits nowhere, more the more of it the name says.
 *
 * `matchesText`'s rule — every word, any order, case and accents aside — with the name weighed
 * above the description, and one allowance a filter does not make: a word may match the name as
 * letters in order, so `albstk` still finds `album-stack`.
 */
export const textScore = (name: string, fields: readonly (string | undefined | null)[], query: string): number => {
  const words = queryWords(query);
  if (words.length === 0) return 0;
  const folded = foldText(name);
  if (folded === words.join(' ')) return 100;
  const nameWords = folded.split(' ');
  const haystack = foldText(fields.filter(Boolean).join(' '));
  let score = 0;
  for (const word of words) {
    if (nameWords.includes(word)) score += 10;
    else if (nameWords.some((part) => part.startsWith(word))) score += 8;
    else if (folded.includes(word)) score += 5;
    else if (haystack.includes(word)) score += 2;
    else if (word.length >= 3 && isSubsequence(word, folded.replace(/ /g, ''))) score += 1;
    else return 0;
  }
  return score / words.length;
};
