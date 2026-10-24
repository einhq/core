import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { IdLockManager } from '../../lib/async/mod.ts';
import { runAsBackground } from '../../lib/pg/mod.ts';
import type { ExecutionManager } from '../exec/mod.ts';
import { ADMIN_ACCESS, ADMIN_GID, ADMIN_UID } from '../../lib/access/mod.ts';
import { createLogger } from '../logger/mod.ts';
import type { BufferManagerIf } from '../buffer/mod.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import { Shell } from '../shell/shell.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { type LogAttrs, NODE_TYPE_LOG } from '../../vfs/types/log.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../vfs/types/session.ts';
import type { ManagerIf } from '../types.ts';
import type { RestartPolicy, ServiceConfig, ServiceInfo, ServiceInstance, ServiceStatus } from './types.ts';

const logger = createLogger('service-registry');

const DEFAULT_STOP_TIMEOUT = 5000;
const DEFAULT_RESTART_WINDOW = 60000;
const DEFAULT_MAX_RESTARTS = 3;

const encodeLogLine = (line: string): string => JSON.stringify(line.endsWith('\r') ? line.slice(0, -1) : line);

export type ServiceManagerConfig = {
  vfs: NodeVFS;
  cem: ExecutionManager;
  bufferManager: BufferManagerIf;
  servicesPath: string;
  logsPath: string;
};

export class ServiceManager implements ManagerIf {
  private services: Map<string, ServiceInstance> = new Map();
  // Lifecycle ops are serialized per service, so an overlapping start/stop/restart
  // waits instead of racing on the instance map and shell.
  private readonly locks = new IdLockManager();
  private readonly vfs: NodeVFS;
  private readonly cem: ExecutionManager;
  private readonly bufferManager: BufferManagerIf;
  private readonly servicesPath: string;
  private readonly logsPath: string;

  constructor(config: ServiceManagerConfig) {
    this.vfs = config.vfs;
    this.cem = config.cem;
    this.bufferManager = config.bufferManager;
    this.servicesPath = config.servicesPath;
    this.logsPath = config.logsPath;
  }

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.stopAll();
  }

  async start(name: string, env: Record<string, string>): Promise<void> {
    await this.locks.withLocks([name], () => this.startLocked(name, env));
  }

  async stop(name: string): Promise<void> {
    await this.locks.withLocks([name], () => this.stopLocked(name));
  }

  async restart(name: string, env: Record<string, string>): Promise<void> {
    await this.locks.withLocks([name], async () => {
      // Stop is best-effort: an instance that has already exited makes stopLocked
      // throw "is not running", and a restart still starts a fresh one.
      if (this.services.has(name)) {
        try {
          await this.stopLocked(name);
        } catch (err) {
          logger.warn(`restart: stop phase for '${name}' failed, starting anyway`, {
            error: (err as Error).message,
          });
        }
      }
      await this.startLocked(name, env);
    });
  }

  private getAvailablePath(name: string): string {
    return join(this.servicesPath, 'available', name);
  }

  private getEnabledPath(name: string): string {
    return join(this.servicesPath, 'enabled', name);
  }

  private async loadConfig(name: string): Promise<ServiceConfig> {
    const configPath = join(this.getAvailablePath(name), 'config.json');
    const config: ServiceConfig = { name };

    try {
      const handle = await this.vfs.open(ADMIN_ACCESS, configPath, { mode: 'r' });
      const content = await toText(handle.readable);
      await handle.close();
      const parsed = JSON.parse(content);
      return { ...config, ...parsed };
    } catch {
      return config;
    }
  }

  private async startLocked(
    name: string,
    env: Record<string, string>,
    restartState?: Pick<ServiceInstance, 'restartCount' | 'restartTimes'>,
  ): Promise<void> {
    if (this.services.has(name)) {
      const instance = this.services.get(name)!;
      if (instance.status === 'running' || instance.status === 'starting') {
        throw new Error(`service '${name}' is already running`);
      }
    }

    const servicePath = this.getAvailablePath(name);
    const startScript = join(servicePath, 'start.sh');

    if (!await this.vfs.exists(ADMIN_ACCESS, servicePath)) {
      throw new Error(`service '${name}' does not exist`);
    }

    if (!await this.vfs.exists(ADMIN_ACCESS, startScript)) {
      throw new Error(`service '${name}' has no start.sh script`);
    }

    const config = await this.loadConfig(name);

    const instance: ServiceInstance = {
      name,
      status: 'starting',
      shell: null as unknown as Shell,
      hangup: new AbortController(),
      exited: Promise.withResolvers<void>(),
      startedAt: Date.now(),
      restartCount: restartState?.restartCount ?? 0,
      restartTimes: restartState?.restartTimes ?? [],
      config,
    };
    this.services.set(name, instance);

    try {
      // The session lives under servicesPath, since the service's own directory may be read-only.
      const sessionsBase = join(this.servicesPath, 'sessions');
      await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, this.servicesPath, 'sessions');
      await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, sessionsBase, name);
      const sessionPath = join(sessionsBase, name, 'session');
      await this.vfs.ensure<SessionAttrs>(
        ADMIN_ACCESS,
        NODE_TYPE_SESSION,
        dirname(sessionPath),
        basename(sessionPath),
        {
          props: {
            mode: 0o700,
          },
          attrs: {
            secret: crypto.randomUUID().replaceAll('-', ''),
            access: {
              uid: ADMIN_UID,
              gid: ADMIN_GID,
              gids: [ADMIN_GID],
            },
            createdAt: Date.now(),
            lastActivity: Date.now(),
            env: {},
          },
        },
      );

      const shell = new Shell({
        cem: this.cem,
        vfs: this.vfs,
        bufferManager: this.bufferManager,
        sessionPath,
        origin: 'service',
        env: {
          SERVICE_NAME: name,
          SERVICE_PATH: servicePath,
          SERVICES_PATH: this.servicesPath,
          ...env,
          ...config.env,
        },
      });
      await shell.open();
      instance.shell = shell;

      await this.setupLogCapture(name, shell);

      instance.status = 'running';
      logger.info(`Service '${name}' started`);

      this.runServiceScript(instance, startScript);
    } catch (err) {
      instance.status = 'failed';
      this.services.delete(name);
      throw err;
    }
  }

  /**
   * Run `start.sh` in the background and handle its exit.
   *
   * The script runs under the instance's own abort signal, and `stopLocked`
   * aborts it alongside the SIGTERM. SIGTERM reaches only the command running
   * at that moment; the abort is checked between commands, so a
   * `while true; do ...; sleep 3600; done` service ends at the interrupted step
   * instead of starting its next pass.
   *
   * A `background` service runs its whole script — and therefore the daemon it
   * starts, and every command that daemon invokes — inside the background
   * postgres work class. Setting it at the root covers every query the service
   * makes, wherever in the call tree it is issued.
   */
  private async runServiceScript(instance: ServiceInstance, startScript: string): Promise<void> {
    const { name, config, shell, hangup } = instance;
    const run = () => shell.run(`source "${startScript}"`, undefined, { signal: hangup.signal });

    try {
      const exitCode = await (config.workClass === 'background' ? runAsBackground(run) : run());
      await this.handleServiceExit(name, shell, exitCode);
    } catch (err) {
      logger.error(`Service '${name}' script error:`, err);
      await this.handleServiceExit(name, shell, 1);
    }
  }

  private async handleServiceExit(name: string, shell: Shell, exitCode: number): Promise<void> {
    const instance = this.services.get(name);
    // A manual restart can install a new instance before the old run promise
    // settles. Its exit belongs to the old shell and must not change or restart
    // the replacement.
    if (!instance || instance.shell !== shell) return;

    instance.lastExitCode = exitCode;
    logger.info(`Service '${name}' exited with code ${exitCode}`);
    instance.exited.resolve();

    // stopLocked keeps the instance in the map while it waits for this
    // transition. An interrupted command commonly reports a non-zero code;
    // that is an intentional stop, not an on-failure restart.
    if (instance.status === 'stopping') {
      instance.status = 'stopped';
      try {
        await instance.shell.close();
      } catch {
        // Ignore close errors
      }
      return;
    }

    const policy = instance.config.restartPolicy || 'never';
    const shouldRestart = this.shouldRestart(instance, policy, exitCode);

    if (shouldRestart) {
      const env = instance.shell.getEnv();
      instance.restartCount++;
      instance.restartTimes.push(Date.now());
      logger.info(`Restarting service '${name}' (attempt ${instance.restartCount})`);

      try {
        await instance.shell.close();
      } catch {
        // Ignore close errors
      }

      // The process is gone during the restart delay. Marking that accurately
      // lets an explicit restart replace it without waiting on a dead shell.
      instance.status = 'failed';

      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.locks.withLocks([name], async () => {
        // A manual restart may have replaced this instance during the delay.
        // In that case the requested lifecycle operation wins.
        if (this.services.get(name) !== instance) return;

        try {
          this.services.delete(name);
          await this.startLocked(name, env, {
            restartCount: instance.restartCount,
            restartTimes: instance.restartTimes,
          });
        } catch (err) {
          logger.error(`Failed to restart service '${name}':`, err);
          instance.status = 'failed';
          this.services.set(name, instance);
        }
      });
    } else {
      instance.status = exitCode === 0 ? 'stopped' : 'failed';
      try {
        await instance.shell.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  private shouldRestart(instance: ServiceInstance, policy: RestartPolicy, exitCode: number): boolean {
    if (policy === 'never') return false;
    if (policy === 'on-failure' && exitCode === 0) return false;

    const maxRestarts = instance.config.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const restartWindow = instance.config.restartWindow ?? DEFAULT_RESTART_WINDOW;
    const now = Date.now();
    const recentRestarts = instance.restartTimes.filter((t) => now - t < restartWindow);

    if (recentRestarts.length >= maxRestarts) {
      logger.warn(`Service '${instance.name}' exceeded max restarts (${maxRestarts}) within window`);
      return false;
    }

    return true;
  }

  private async setupLogCapture(name: string, shell: Shell): Promise<void> {
    // Service definitions are configuration under /etc; their mutable output
    // belongs with the other machine-owned logs under /var/logs.
    const logsBase = join(this.logsPath, 'services');
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, this.logsPath, 'services');
    const logsPath = this.getLogsPath(name);

    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, logsBase, name);

    // Each start truncates the pair of log nodes, so they hold this run's output.
    const stdoutPath = join(logsPath, 'stdout.log');
    const stderrPath = join(logsPath, 'stderr.log');

    await this.ensureLogNode(stdoutPath);
    await this.ensureLogNode(stderrPath);

    this.pipeHandleToLog(await shell.openIOHandle('stdout', 'r'), stdoutPath).catch((err) => logger.error(`Failed to pipe stdout for service '${name}':`, err));
    this.pipeHandleToLog(await shell.openIOHandle('stderr', 'r'), stderrPath).catch((err) => logger.error(`Failed to pipe stderr for service '${name}':`, err));
  }

  private async ensureLogNode(path: string): Promise<void> {
    if (await this.vfs.exists(ADMIN_ACCESS, path)) {
      const node = await this.vfs.get(ADMIN_ACCESS, path);
      if (node.type !== NODE_TYPE_LOG) {
        throw new Error(`service log path '${path}' has unsupported node type '${node.type}'`);
      }

      const handle = await this.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      await handle.close();
      return;
    }

    const name = basename(path);
    const attrs: LogAttrs = { retention: 'forever' };
    await this.vfs.create(ADMIN_ACCESS, NODE_TYPE_LOG, dirname(path), name, { attrs });
  }

  private async pipeHandleToLog(sourceHandle: ResourceHandleIf, logPath: string): Promise<void> {
    const logHandle = await this.vfs.open(ADMIN_ACCESS, logPath, { mode: 'a' });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';

    // A LogHandle accepts newline-delimited JSON, while service output is an
    // arbitrary byte stream whose chunks need not end on either a line or a
    // UTF-8 boundary. Frame it into JSON-string entries before appending.
    const entries = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (lines.length > 0) {
          controller.enqueue(encoder.encode(`${lines.map(encodeLogLine).join('\n')}\n`));
        }
      },
      flush: (controller) => {
        pending += decoder.decode();
        if (pending.length > 0) {
          controller.enqueue(encoder.encode(`${encodeLogLine(pending)}\n`));
        }
      },
    });

    try {
      await sourceHandle.readable.pipeThrough(entries).pipeTo(logHandle.writable);
    } finally {
      await sourceHandle.close();
      await logHandle.close();
    }
  }

  private async stopLocked(name: string): Promise<void> {
    const instance = this.services.get(name);
    if (!instance) {
      throw new Error(`service '${name}' is not running`);
    }

    if (instance.status === 'stopping') {
      throw new Error(`service '${name}' is already stopping`);
    }

    if (instance.status !== 'running' && instance.status !== 'starting') {
      throw new Error(`service '${name}' is not running`);
    }

    instance.status = 'stopping';
    const stopTimeout = instance.config.stopTimeout ?? DEFAULT_STOP_TIMEOUT;

    logger.info(`Stopping service '${name}'...`);

    // Abort first, so the script does not step past the command SIGTERM
    // interrupts — see `runServiceScript`.
    instance.hangup.abort(new Error('service stopping'));
    try {
      await this.cem.signal(instance.shell.name, 'SIGTERM');
    } catch {
      // Signalling might fail if the shell is already closed
    }

    // Wait for the exit, up to the grace; `handleServiceExit` resolves `exited`.
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        instance.exited.promise,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, stopTimeout);
        }),
      ]);
    } finally {
      clearTimeout(grace);
    }

    if (instance.status === 'stopping') {
      logger.warn(`Force stopping service '${name}' after timeout`);
      try {
        await instance.shell.close();
      } catch {
        // Ignore close errors
      }
      instance.status = 'stopped';
    }

    this.services.delete(name);
    logger.info(`Service '${name}' stopped`);
  }

  get(name: string): ServiceInstance | undefined {
    return this.services.get(name);
  }

  getLogsPath(name: string): string {
    return join(this.logsPath, 'services', name);
  }

  getStatus(name: string): ServiceStatus {
    const instance = this.services.get(name);
    return instance?.status || 'stopped';
  }

  async getInfo(name: string): Promise<ServiceInfo> {
    const instance = this.services.get(name);
    const config = await this.loadConfig(name);
    const enabled = await this.vfs.exists(ADMIN_ACCESS, this.getEnabledPath(name));

    return {
      name,
      status: instance?.status || 'stopped',
      enabled,
      description: config.description,
      startedAt: instance?.startedAt,
      restartCount: instance?.restartCount,
      statusCommand: config.statusCommand,
      checkCommand: config.checkCommand,
      gaugeCommand: config.gaugeCommand,
    };
  }

  async listAvailable(): Promise<string[]> {
    const availablePath = join(this.servicesPath, 'available');
    try {
      const children = await this.vfs.children(ADMIN_ACCESS, availablePath);
      return children.map((c) => c.name);
    } catch {
      return [];
    }
  }

  async listEnabled(): Promise<string[]> {
    const enabledPath = join(this.servicesPath, 'enabled');
    try {
      const children = await this.vfs.children(ADMIN_ACCESS, enabledPath);
      return children.map((c) => c.name);
    } catch {
      return [];
    }
  }

  async list(): Promise<ServiceInfo[]> {
    const available = await this.listAvailable();
    const infos: ServiceInfo[] = [];

    for (const name of available) {
      infos.push(await this.getInfo(name));
    }

    return infos;
  }

  async startAll(env: Record<string, string>): Promise<void> {
    const enabled = await this.listEnabled();
    for (const name of enabled) {
      try {
        if (!this.services.has(name) || this.services.get(name)?.status !== 'running') {
          await this.start(name, env);
        }
      } catch (err) {
        logger.error(`Failed to start service '${name}':`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    const running = [...this.services.keys()];
    // Every service is stopped at once. One after another, a slow service's
    // stop timeout delays the rest, and the container manager may kill the
    // process before the pool workers release their claimed steps and leases.
    // Lifecycle locks are per service, so independent stops can run together.
    await Promise.all(running.map(async (name) => {
      try {
        await this.stop(name);
      } catch (err) {
        logger.error(`Failed to stop service '${name}':`, err);
      }
    }));
  }
}
