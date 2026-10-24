import type { JSONObject } from '../../types.ts';
import type { AuditedWrite } from './audit.ts';
import type { NodeId, NodePath } from './ids.ts';

export type DomainEvent = {
  /** Unique event id (ulid). */
  id: string;
  /** Dotted fact name, e.g. `media.metadata.extracted`. */
  type: string;
  /** VFS path of the node the fact is about — becomes `$NODE_PATH` for the pipeline. */
  subject: NodePath;
  /** Id of the subject node, when known. */
  nodeId?: NodeId;
  /** Emission time (epoch ms). */
  time: number;
  /** Who emitted it, e.g. `archive-bridge`. Informational. */
  source?: string;
  /** The write the fact was derived from, when it was derived from one. */
  write?: AuditedWrite;
  /**
   * The lane the work it starts runs in. Absent is the normal lane; `bulk` is for work nobody is
   * waiting on, such as a large import, which the pipeline engine schedules below every job of
   * the normal lane, so what a person just uploaded is processed first.
   */
  lane?: 'bulk';
  /**
   * Everything a trigger needs to decide without re-reading the node. Kept flat
   * and small: each key is exported to `filter`/`skipIf`/step commands as
   * `$EVENT_<UPPER_SNAKE>`.
   */
  data?: JSONObject;
};
