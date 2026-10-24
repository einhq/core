import type { ManagerIf } from '../types.ts';

export type RelayEventConsumer = (routingKey: string, payload: unknown) => Promise<void>;
export type RelayEventUnsubscriber = () => void;

export interface RouterManagerIf extends ManagerIf {
  publish(routingKey: string, payload: unknown): void;
  on(handler: RelayEventConsumer): RelayEventUnsubscriber;
  /** Flush startup queue and switch to live delivery. Call once after boot. */
  release(): void;
}
