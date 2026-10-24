import type { NodeTypeDoc } from '../reference/types.ts';
import type { NodeQueryCollation } from '../../vfs/query.ts';

/**
 * What a module contributes to core's own machinery, declared in `mod.json` rather than recognised
 * by naming convention or written into core.
 */

/**
 * An index on node attrs, for a query the module's data is asked. Created by `mod setup` as
 * `<attrs table>_<name>_idx` over each `on` attr's sort expression and the node id, partial on
 * `partial` being set. An attr is a name, or a dotted path into a nested attr (`relation.from`).
 * The attrs are held in `collation` (default `bytes`), and serve an order under that collation.
 *
 * `using: 'trigram'` makes it a trigram index over one attr's text instead, which serves
 * `contains` (a substring anywhere in the text) and no order. `using: 'statistics'` makes no index
 * at all, only the planner's statistics on one attr's text: what a condition no index serves needs
 * for an honest estimate, `missing` on an attr few rows carry above all.
 */
export type IndexDecl = {
  name: string;
  on: string[];
  partial?: string;
  collation?: NodeQueryCollation;
  using?: 'trigram' | 'statistics';
};

/** An entity an `@` can complete to: nodes of `type` directly under `root`. */
export type Completion = {
  type: string;
  root: string;
};

export type Contributions = {
  /** The module's node types; one with a `root` is what an `@` completes to. */
  nodeTypes?: Pick<NodeTypeDoc, 'type' | 'root'>[];
  indexes?: IndexDecl[];
  /**
   * The archive roots the module's content lives under (`/archive/people`). `mod setup` creates a
   * missing one, owned by the admin and the users group, mode 775; nothing ever removes one.
   */
  roots?: string[];
};
