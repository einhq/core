import type { Shell } from '../shell/shell.ts';

export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed';

export type RestartPolicy = 'always' | 'on-failure' | 'never';

export type ServiceConfig = {
  name: string;
  description?: string;
  restartPolicy?: RestartPolicy;
  maxRestarts?: number;
  restartWindow?: number;
  stopTimeout?: number;
  env?: Record<string, string>;
  /**
   * A command that reports this service's own health in one line, run while it is running.
   *
   * `running` is all the manager can say by itself; a service that can be up and still degraded
   * (say, running on the CPU instead of the GPU) names a command that knows.
   *
   * First line of stdout wins, empty means nothing to report, and a failure or a timeout is
   * silent — this is a detail beside a status, never the status itself. It runs with the same
   * trust as `start.sh`, which core already executes from the same directory.
   */
  statusCommand?: string;
  /**
   * A command that answers checks on what this service watches, for `health`: with
   * `JSON_OUTPUT=1`, a JSON array of `{ name, state: 'ok' | 'warn' | 'fail', reason }`. `fail` means
   * a person has something to do. Asked only while the service runs; a failure or a timeout is
   * reported as a `warn` against the service, never as the thing it watches failing.
   */
  checkCommand?: string;
  /**
   * A command that answers gauges for `top` and the dashboard: with `JSON_OUTPUT=1`, a JSON array of
   * `{ label, percent?, value }` — a meter drawn beside the host's RAM, such as a card's memory.
   */
  gaugeCommand?: string;
  /**
   * Which half of the postgres pool this service's work belongs to.
   *
   * `background` means everything the service does — its script, the daemon it
   * starts, and every command either invokes — acquires postgres connections
   * under a reservation that keeps some of the pool reachable by interactive
   * work, so a busy crawl does not delay a person's shell.
   *
   * Unset means interactive, which is what a server service needs: the shells
   * it accepts run inside its context.
   */
  workClass?: 'interactive' | 'background';
};

export type ServiceInstance = {
  name: string;
  status: ServiceStatus;
  shell: Shell;
  /**
   * Hangs up the script itself, not just the command it is running. See
   * `ServiceManager.runServiceScript`.
   */
  hangup: AbortController;
  /** Settles when the script has exited, however it did; what a stop waits on. */
  exited: PromiseWithResolvers<void>;
  startedAt: number;
  restartCount: number;
  restartTimes: number[];
  lastExitCode?: number;
  config: ServiceConfig;
};

export type ServiceInfo = {
  name: string;
  status: ServiceStatus;
  enabled: boolean;
  description?: string;
  startedAt?: number;
  restartCount?: number;
  /** See `ServiceConfig.statusCommand`. Carried so a caller can decide whether to run it. */
  statusCommand?: string;
  /** See `ServiceConfig.checkCommand`. */
  checkCommand?: string;
  /** See `ServiceConfig.gaugeCommand`. */
  gaugeCommand?: string;
};
