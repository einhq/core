/**
 * VFS Event Emitter
 *
 * Provides event subscription and dispatch for VFS mutations.
 * Supports filtering by event type, node ID, path prefix, and node type.
 */

import { ulid } from '@std/ulid';
import { Access, verifyAccess } from '../lib/access/mod.ts';
import { createLogger } from '../managers/logger/mod.ts';
import type { NodeAttrs } from './node.ts';
import type { EventSubscription, EventSubscriptionFilter, EventSubscriptionHandler, NodeEvent } from './types.ts';

const logger = createLogger('vfs-event-emitter');

type Subscription<T extends NodeAttrs = NodeAttrs> = {
  id: string;
  getAccess: () => Promise<Access> | Access;
  handler: EventSubscriptionHandler<T>;
  filter?: EventSubscriptionFilter;
};

/**
 * Whether `access` can walk to the directory holding `path`, as a path lookup
 * would require: execute on every ancestor.
 */
type PathReachable = (access: Access, path: string) => Promise<boolean>;

/**
 * Event emitter for VFS node events
 */
export class VfsEventEmitter {
  private subscriptions: Map<string, Subscription> = new Map();

  /**
   * @param reachable Checked after the node's own mode: an event is only as
   *   visible as its node would be to a path lookup. Omitted, only the node's mode
   *   is checked.
   */
  constructor(private readonly reachable?: PathReachable) {}

  /**
   * Subscribe to VFS events with optional filtering
   */
  subscribe<T extends NodeAttrs = NodeAttrs>(
    getAccess: () => Promise<Access> | Access,
    handler: EventSubscriptionHandler<T>,
    filter?: EventSubscriptionFilter,
  ): EventSubscription {
    const id = ulid();
    this.subscriptions.set(id, {
      id,
      handler: handler as EventSubscriptionHandler,
      getAccess,
      filter,
    });

    return {
      unsubscribe: async () => {
        this.subscriptions.delete(id);
      },
    };
  }

  /**
   * Emit an event to all matching subscribers, awaiting them all. The VFS calls
   * it only after the emitting mutation has committed and dropped its locks.
   */
  async emit<T extends NodeAttrs = NodeAttrs>(event: NodeEvent<T>): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const sub of this.subscriptions.values()) {
      const access = await sub.getAccess();

      if (!verifyAccess(access, event.node.props, 'r')) {
        continue;
      }

      if (!this.matchesFilter(event, sub.filter)) {
        continue;
      }

      if (this.reachable && !(await this.reachable(access, event.path).catch(() => false))) {
        continue;
      }

      try {
        const result = sub.handler(event);
        if (result instanceof Promise) {
          promises.push(
            result.catch((err) => {
              logger.error('Event handler error', { error: err, subscriptionId: sub.id });
            }),
          );
        }
      } catch (err) {
        logger.error('Event handler sync error', { error: err, subscriptionId: sub.id });
      }
    }

    await Promise.all(promises);
  }

  /**
   * Check if an event matches a subscription filter
   */
  private matchesFilter<T extends NodeAttrs>(
    event: NodeEvent<T>,
    filter?: EventSubscriptionFilter,
  ): boolean {
    if (!filter) return true;

    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.type)) {
        return false;
      }
    }

    if (filter.pathPrefix) {
      const recursive = filter.recursive !== false; // default true

      if (recursive) {
        // Match if path starts with prefix
        const prefix = filter.pathPrefix === '/' ? '/' : filter.pathPrefix;
        if (prefix === '/') {
          // Root matches everything
        } else if (!event.path.startsWith(prefix)) {
          return false;
        } else {
          // Must match exactly or be followed by /
          const rest = event.path.slice(prefix.length);
          if (rest.length > 0 && !rest.startsWith('/')) {
            return false;
          }
        }
      } else {
        // Direct children only - match exact path or one level below
        const prefix = filter.pathPrefix.endsWith('/') ? filter.pathPrefix : filter.pathPrefix + '/';
        const isDirectChild = event.path === filter.pathPrefix ||
          (event.path.startsWith(prefix) && !event.path.slice(prefix.length).includes('/'));
        if (!isDirectChild && event.path !== filter.pathPrefix) {
          return false;
        }
      }
    }

    if (filter.nodeTypes && filter.nodeTypes.length > 0) {
      if (!event.node || !filter.nodeTypes.includes(event.node.type)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Clear all subscriptions (for cleanup)
   */
  clear(): void {
    this.subscriptions.clear();
  }
}
