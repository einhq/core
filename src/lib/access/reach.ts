/**
 * Reach: who can get to a node along some path, as a formula over the grants of the directories
 * on the way. A store keeps each node's reach (ein/core#674), so a lookup by id or by index
 * checks one value instead of walking the path back up:
 *
 * ```
 * reach(root) = everyone
 * reach(n)    = OR over parents p of n:  reach(p) AND passes(p)
 * visible(n)  = admin OR (reach(n) admits the caller AND n grants it r)
 * ```
 *
 * `passes(p)` is who `p` lets through — execute, as `verifyAccess` grants it — written as
 * grantees rather than resolved, so group membership and a share link's expiry are judged against
 * the caller when it reads, and changing either rewrites nothing.
 */

import { isLinkUid } from './constants.ts';
import type { Access } from './types.ts';
import { linkLive } from './verify-access.ts';
import type { Ownership } from '../mode/mod.ts';

/**
 * One who may pass a node: `*` anyone, `u:N` the user N, `g:N` a member of group N, `a:N` the
 * share link N while it is live.
 */
type Grantee = string;

/** Who passes one node: any one of them does. Sorted, without repeats; `['*']` is anyone. */
type Grantees = Grantee[];

/** One way down: a caller passing every set of grantees on it. An empty term is anyone. */
type ReachTerm = Grantees[];

/**
 * Who can get to a node: anyone some term admits. Normalized by `normalizeReach`, so two formulas
 * admit the same callers when, as written, they are equal; `[]` is nobody, `[[]]` everyone.
 */
export type ReachFormula = ReachTerm[];

export const REACH_EVERYONE: ReachFormula = [[]];
export const REACH_NOBODY: ReachFormula = [];

const ANYONE = '*';

/**
 * Who `ownership` lets through, as `verifyAccess(access, ownership, 'x')` decides it for anyone
 * but an administrator: the owner, the group or anyone by the mode bits, and the access list's
 * entries granting execute. An access-list entry naming an account is the same grant as owning,
 * and is written as one; only a share link's depends on the link being live.
 */
export const passes = (ownership: Ownership): Grantees => {
  if (ownership.mode & 0o001) return [ANYONE];
  const grantees = new Set<Grantee>();
  if (ownership.mode & 0o100) grantees.add(`u:${ownership.uid}`);
  if (ownership.mode & 0o010) grantees.add(`g:${ownership.gid}`);
  for (const entry of ownership.acl ?? []) {
    if (!(entry.mode & 0o001)) continue;
    if (entry.uid !== undefined) grantees.add(isLinkUid(entry.uid) ? `a:${entry.uid}` : `u:${entry.uid}`);
    if (entry.gid !== undefined) grantees.add(`g:${entry.gid}`);
  }
  return [...grantees].sort();
};

const isSubset = (a: Grantees, b: Grantees): boolean => a.length <= b.length && a.every((grantee) => b.includes(grantee));

/** Whether `term` admits nobody but those `other` admits: each set of `other` holds one of `term`'s. */
const implies = (term: ReachTerm, other: ReachTerm): boolean => other.every((set) => term.some((own) => isSubset(own, set)));

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A term with what adds nothing left out: a set holding anyone, a repeat, and a set that holds
 * another of the term's whole (whoever passes the smaller passes it). Undefined when the term
 * admits nobody: it has an empty set.
 */
const normalizeTerm = (term: ReachTerm): ReachTerm | undefined => {
  const sets = new Map<string, Grantees>();
  for (const set of term) {
    if (set.length === 0) return undefined;
    if (set.includes(ANYONE)) continue;
    const sorted = [...new Set(set)].sort();
    sets.set(JSON.stringify(sorted), sorted);
  }
  const all = [...sets.values()];
  const kept = all.filter((set) => !all.some((other) => other !== set && isSubset(other, set)));
  return kept.sort((a, b) => compareKeys(JSON.stringify(a), JSON.stringify(b)));
};

/**
 * `formula` in its one written form: each term normalized, a term admitting nobody dropped, and a
 * term dropped when another admits everyone it does; the rest sorted.
 */
export const normalizeReach = (formula: ReachFormula): ReachFormula => {
  const terms = new Map<string, ReachTerm>();
  for (const term of formula) {
    const normal = normalizeTerm(term);
    if (normal) terms.set(JSON.stringify(normal), normal);
  }
  const all = [...terms.values()];
  const kept = all.filter((term) => !all.some((other) => other !== term && implies(term, other)));
  return kept.sort((a, b) => compareKeys(JSON.stringify(a), JSON.stringify(b)));
};

/** The text a normalized formula is stored and looked up by. */
export const reachKey = (formula: ReachFormula): string => JSON.stringify(formula);

/** Who gets to a child through a parent that `reach` gets to and that lets `through` pass. */
export const reachThrough = (reach: ReachFormula, through: Grantees): ReachFormula => {
  if (through.includes(ANYONE)) return reach;
  if (through.length === 0) return REACH_NOBODY;
  return normalizeReach(reach.map((term) => [...term, through]));
};

/** Who gets to a node by any of its ways down. */
export const reachAny = (formulas: ReachFormula[]): ReachFormula => normalizeReach(formulas.flat());

/** Whether `access` is one of `grantee`, judged now; administrators are left to the caller. */
const admits = (grantee: Grantee, access: Access, live: boolean): boolean => {
  if (grantee === ANYONE) return true;
  const id = Number(grantee.slice(2));
  switch (grantee[0]) {
    case 'u':
      return access.uid === id;
    case 'g':
      return access.gids.includes(id);
    case 'a':
      return access.uid === id && live;
    default:
      return false;
  }
};

/** Whether `access` gets to a node of reach `formula`, administrators aside. */
export const reachAdmits = (formula: ReachFormula, access: Access, now = Date.now()): boolean => {
  const live = access.link === undefined || linkLive(access, now);
  return formula.some((term) => term.every((set) => set.some((grantee) => admits(grantee, access, live))));
};

/** The ids `formula` names: users' (as owner, in an access list, or a share link's) and groups'. */
export const reachNamed = (formula: ReachFormula): { uids: number[]; gids: number[] } => {
  const uids = new Set<number>();
  const gids = new Set<number>();
  for (const grantee of formula.flat(2)) {
    if (grantee === ANYONE) continue;
    (grantee[0] === 'g' ? gids : uids).add(Number(grantee.slice(2)));
  }
  return { uids: [...uids].sort((a, b) => a - b), gids: [...gids].sort((a, b) => a - b) };
};

/**
 * What an access is judged by when a reach is evaluated: who it is, its groups, and whether its
 * share link is live. Two accesses with the same key are admitted by the same formulas.
 */
export const reachAccessKey = (access: Access, now = Date.now()): string =>
  `${access.uid}|${[...new Set(access.gids)].sort((a, b) => a - b).join(',')}|${access.link === undefined || linkLive(access, now) ? 1 : 0}`;
