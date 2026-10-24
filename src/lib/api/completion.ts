import type { NodeOwnership } from './ids.ts';

/**
 * `completion-entity`: one entity whose name matches. `kind` is the completion kind a module
 * declares (person, album, …), `type` its node type, which says what opens it.
 */
export type EntityCompleteHit = {
  kind: string;
  type: string;
  name: string;
  path: string;
  score: number;
  /** Who may change the entity, so a picker offers only the ones the reader may add to. */
  ownership: NodeOwnership;
};

export type EntityCompleteResult = { results: EntityCompleteHit[] };
