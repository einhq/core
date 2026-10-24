/**
 * Domain events — the fact layer between what happened in the VFS and what work
 * should run.
 *
 * A VFS event says "this node changed". A domain event says "this file now has
 * EXIF", "this face was detected". Pipelines trigger on the latter: facts are a
 * projection of VFS state, so they are re-derivable after a gap, and they
 * decouple the producer of a fact from every consumer of it.
 *
 * Events are published by writing one JSON object per line to a router node —
 * `/dev/events`, bound to the `system.events` routing key. Anything that can
 * write to a VFS node can publish; there is no dedicated command or API.
 */

export const EVENTS_ROUTING_KEY = 'system.events';
import { EVENTS_NODE_PATH, PIPELINE_EVENTS_NODE_PATH } from '../paths.ts';
import type { DomainEvent } from '../api/events.ts';
export type { DomainEvent } from '../api/events.ts';
export { EVENTS_NODE_PATH };

export { PIPELINE_EVENTS_NODE_PATH };

/** True if `value` is shaped like a domain event rather than a slim VFS event. */
export const isDomainEvent = (value: unknown): value is DomainEvent => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DomainEvent>;

  return typeof candidate.type === 'string' && typeof candidate.subject === 'string';
};

/** `deviceSerial` -> `DEVICE_SERIAL`, `mimetype` -> `MIMETYPE`. */
const toEnvName = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();

/**
 * Shell env exported for a domain event. `NODE_PATH` is the subject, so step
 * commands written against the VFS trigger form keep working unchanged.
 */
export const eventEnv = (event: DomainEvent): Record<string, string> => {
  const env: Record<string, string> = {
    NODE_PATH: event.subject,
    EVENT_TYPE: event.type,
    EVENT_ID: event.id ?? '',
    EVENT_SOURCE: event.source ?? '',
    EVENT_DATA: event.data ? JSON.stringify(event.data) : '',
  };

  for (const [key, value] of Object.entries(event.data ?? {})) {
    const name = `EVENT_${toEnvName(key)}`;

    // A data key must not be able to shadow the fields above
    if (name in env) {
      continue;
    }

    if (value === null || value === undefined) {
      env[name] = '';
    } else if (typeof value === 'object') {
      env[name] = JSON.stringify(value);
    } else {
      env[name] = String(value);
    }
  }

  return env;
};

/** Render an event as the JSONL line to write to `/dev/events`. */
export const serializeEvent = (event: DomainEvent): string => `${JSON.stringify(event)}\n`;
