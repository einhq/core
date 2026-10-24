import type { RouterManagerIf } from '../../managers/router/types.ts';
import { RegistryIf, ResourceOptions } from '../types.ts';

export type RouterResourceOptions = ResourceOptions & {
  /** Routing key writes are published on. Absent: writes reach only the node's own readers. */
  routingKey?: string;
};

/** Configuration for creating a router registry. */
export type RouterRegistryConfig = {
  /** Router manager used to receive routed events for fanout delivery. */
  router: RouterManagerIf;
};

export type RouterStat = {
  routingKey?: string;
  subscribers: number;
};

export interface RouterRegistryIf extends RegistryIf<RouterResourceOptions, RouterStat> {
  publish(routingKey: string, payload: unknown): void;
}
