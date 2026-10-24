/**
 * Stored reach (see `lib/access/reach.ts`): the interned formulas of one store, and the walk that
 * keeps every node's reach current after a write. A store that keeps reach offers
 * `NodeStore.reachable` and calls `refreshReach` from every write that changes a node's parents or
 * who it lets through.
 */

import {
  type Access,
  normalizeReach,
  passes,
  REACH_EVERYONE,
  REACH_NOBODY,
  reachAccessKey,
  reachAdmits,
  reachAny,
  type ReachFormula,
  reachKey,
  reachNamed,
  reachThrough,
} from '../lib/access/mod.ts';
import type { Ownership } from '../lib/mode/mod.ts';
import type { NodeId } from './node.ts';

/** A parent as a reach is computed from: its own reach (null while unknown) and who it lets through. */
type ReachParent = { reach: number | null; ownership: Ownership };

/** A node as `refreshReach` reads it: its stored reach and every parent edge's parent, one per edge. */
export type ReachRow = { reach: number | null; parents: ReachParent[] };

/** Callers whose admitted classes are kept; past this the oldest is forgotten. */
const ADMITTED_CACHE = 256;

/**
 * The distinct reach formulas of one store, each under a number. A number never changes its
 * formula and is never given again once its class is deleted, so what is known of one is never
 * stale, and whom a class admits is kept per caller until new classes arrive, and then only they
 * are evaluated. A deleted class is dropped with `forget`.
 */
export class ReachClasses {
  private formulas = new Map<number, ReachFormula>();
  private ids = new Map<string, number>();
  /** Every class, in the order it became known. */
  private order: number[] = [];
  /** Per caller (`reachAccessKey`): the classes admitting it among the first `known` of `order`. */
  private admittedBy = new Map<string, { known: number; ids: Set<number> }>();
  /** `reachThrough` of a class and a parent's grants, as a class. */
  private through = new Map<string, number>();

  /**
   * @param persist Stores a new formula and answers its number; called once per formula this
   *   process has not seen, and must answer the number another writer gave it first.
   */
  constructor(private readonly persist: (key: string, formula: ReachFormula) => Promise<number>) {}

  /** Learns classes read back from where they are kept. */
  learn(rows: Iterable<{ id: number; formula: ReachFormula }>): void {
    for (const { id, formula } of rows) {
      if (this.formulas.has(id)) continue;
      this.formulas.set(id, formula);
      this.ids.set(reachKey(formula), id);
      this.order.push(id);
    }
  }

  /** The highest class number known, 0 for none: where reading new ones back starts. */
  get latest(): number {
    return this.order.reduce((max, id) => Math.max(max, id), 0);
  }

  has(id: number): boolean {
    return this.formulas.has(id);
  }

  formula(id: number): ReachFormula | undefined {
    return this.formulas.get(id);
  }

  /** Every class known, by number. */
  entries(): IterableIterator<[number, ReachFormula]> {
    return this.formulas.entries();
  }

  /** Every class number known. */
  known(): number[] {
    return [...this.order];
  }

  /** Drops classes deleted where they are kept; no node may refer to them. */
  forget(ids: Iterable<number>): void {
    let dropped = false;
    for (const id of ids) {
      const formula = this.formulas.get(id);
      if (!formula) continue;
      this.formulas.delete(id);
      this.ids.delete(reachKey(formula));
      dropped = true;
    }
    if (!dropped) return;
    this.order = this.order.filter((id) => this.formulas.has(id));
    this.admittedBy.clear();
    this.through.clear();
  }

  /** Forgets everything, for a store whose tables were made anew. */
  clear(): void {
    this.formulas.clear();
    this.ids.clear();
    this.order = [];
    this.admittedBy.clear();
    this.through.clear();
  }

  /** The number of `formula`, normalized, made when it has none yet. */
  async intern(formula: ReachFormula): Promise<number> {
    const normal = normalizeReach(formula);
    const key = reachKey(normal);
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = await this.persist(key, normal);
    this.learn([{ id, formula: normal }]);
    return id;
  }

  /** The reach of a node under `parents`, one per edge; the root's is everyone. */
  async reachOf(parents: ReachParent[], root: boolean): Promise<number> {
    if (root) return await this.intern(REACH_EVERYONE);
    if (parents.length === 1) return await this.under(parents[0]);
    const formulas = await Promise.all(parents.map(async (parent) => this.formula(await this.under(parent))!));
    return await this.intern(reachAny(formulas));
  }

  /** The reach of a child through `parent` alone. */
  async under(parent: ReachParent): Promise<number> {
    const grants = passes(parent.ownership);
    const memo = `${parent.reach}|${grants.join(',')}`;
    const known = this.through.get(memo);
    if (known !== undefined) return known;
    const reach = parent.reach === null ? REACH_NOBODY : this.formula(parent.reach);
    if (reach === undefined) throw new Error(`reach class ${parent.reach} is unknown`);
    const id = await this.intern(reachThrough(reach, grants));
    this.through.set(memo, id);
    return id;
  }

  /** The classes admitting `access` (administrators aside), among those known. */
  admitted(access: Access, now = Date.now()): Set<number> {
    const key = reachAccessKey(access, now);
    let entry = this.admittedBy.get(key);
    if (entry) {
      this.admittedBy.delete(key);
    } else {
      if (this.admittedBy.size >= ADMITTED_CACHE) this.admittedBy.delete(this.admittedBy.keys().next().value!);
      entry = { known: 0, ids: new Set() };
    }
    this.admittedBy.set(key, entry);
    for (; entry.known < this.order.length; entry.known++) {
      const id = this.order[entry.known];
      if (reachAdmits(this.formulas.get(id)!, access, now)) entry.ids.add(id);
    }
    return entry.ids;
  }
}

/** What `refreshReach` reads and writes of a store. */
export type ReachGraph = {
  rootId: NodeId;
  classes: ReachClasses;
  /** Each id held, with its stored reach and its parents; an id gone is absent. */
  rows(ids: NodeId[]): Promise<Map<NodeId, ReachRow>>;
  /** The children of `ids`, each once. */
  children(ids: NodeId[]): Promise<NodeId[]>;
  write(reaches: Map<NodeId, number>): Promise<void>;
};

/** Nodes read per `rows` call. */
const REFRESH_BATCH = 5000;

/** Levels a refresh goes down before it takes the hierarchy for a cycle, which the VFS forbids. */
const MAX_REFRESH_LEVELS = 1024;

/**
 * Brings the reach of `ids`, and of everything below them, up to date: each node's is computed from
 * all its parents — a hard link from elsewhere counts — and written when it changed, and the walk
 * goes on below only the nodes that changed. A node met again further down, through a second
 * parent, is computed again with what is known by then, so the walk ends with every node agreeing
 * with its parents. Answers how many nodes were written.
 */
export const refreshReach = async (graph: ReachGraph, ids: NodeId[]): Promise<number> => {
  let frontier = [...new Set(ids)];
  let written = 0;
  for (let level = 0; frontier.length > 0; level++) {
    if (level > MAX_REFRESH_LEVELS) throw new Error('reach refresh did not end: the hierarchy has a cycle');
    const changed: NodeId[] = [];
    for (let start = 0; start < frontier.length; start += REFRESH_BATCH) {
      const batch = frontier.slice(start, start + REFRESH_BATCH);
      const rows = await graph.rows(batch);
      const reaches = new Map<NodeId, number>();
      for (const id of batch) {
        const row = rows.get(id);
        if (!row) continue;
        const reach = await graph.classes.reachOf(row.parents, id === graph.rootId);
        if (reach !== row.reach) reaches.set(id, reach);
      }
      if (reaches.size > 0) await graph.write(reaches);
      changed.push(...reaches.keys());
      written += reaches.size;
    }
    frontier = changed.length > 0 ? await graph.children(changed) : [];
  }
  return written;
};

/** The ids any of `formulas` names, each once; see `reachNamed`. */
export const namedBy = (formulas: ReachFormula[]): { uids: number[]; gids: number[] } => {
  const uids = new Set<number>();
  const gids = new Set<number>();
  for (const formula of formulas) {
    const named = reachNamed(formula);
    for (const uid of named.uids) uids.add(uid);
    for (const gid of named.gids) gids.add(gid);
  }
  return { uids: [...uids].sort((a, b) => a - b), gids: [...gids].sort((a, b) => a - b) };
};

/** Whether who `before` and `after` let through differ, so what is below them must be refreshed. */
export const passesChanged = (before: Ownership, after: Ownership): boolean => passes(before).join(',') !== passes(after).join(',');
