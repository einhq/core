/**
 * The EiN primary: connects to PostgreSQL, builds the VFS and the managers, boots the instance
 * and runs until a shutdown signal (`deno task dev`).
 */

import { isSecretKey } from './lib/config/read-settings.ts';
import { LOGS_PATH, SERVICES_PATH } from './lib/paths.ts';
import { resolve } from '@std/path';
import { Pool } from 'pg';
import { registerPoolStats } from './lib/metrics/runtime.ts';
import { PriorityPool, updateExtensions } from './lib/pg/mod.ts';
import { boot } from './init/boot.ts';
import { SYSTEM_TIME_ZONE } from './lib/datetime/mod.ts';
import { BufferManager } from './managers/buffer/mod.ts';
import { ExecManager } from './managers/exec/mod.ts';
import { connectLoggerToRouter, createLogger, initializeLogger } from './managers/logger/mod.ts';
import { RouterManager } from './managers/router/mod.ts';
import { ServiceManager } from './managers/services/mod.ts';
import { ShellManager } from './managers/shell/mod.ts';
import { RouterRegistry } from './registries/router/mod.ts';
import { InMemoryStore } from './stores/memory/index.ts';
import type { SystemCore } from './system-core.ts';
import { LocalNodeVFS } from './vfs/mod.ts';

const logger = createLogger('main');

// Configuration from environment
const POSTGRES_URL = Deno.env.get('POSTGRES_URL') || 'postgres://ein:ein@127.0.0.1:5432/ein';
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type ShutdownSignal = typeof SHUTDOWN_SIGNALS[number];

/**
 * The settings this process was launched with, for the shells.
 *
 * `CFG_` is the prefix for anything the settings page can own; POSTGRES_URL,
 * FILE_ROOT_PATH and the rest are bootstrap facts read before a VFS exists and
 * deliberately keep their own names. A secret (`CFG_*_KEY`) stays in this
 * process's environment, where the code that calls its service reads it.
 */
const settingsFromEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key, value]) => key.startsWith('CFG_') && !isSecretKey(key) && value !== ''),
  );

async function main() {
  initializeLogger();
  logger.info('=== EiN Primary Instance ===');
  // Every timestamp below is in this zone; a log off the host's clock gives the reader nothing
  // to notice otherwise.
  logger.info('Timezone', { timezone: SYSTEM_TIME_ZONE });

  // Router manager first — logger connects to it
  const routerManager = new RouterManager();
  await routerManager.init();

  // Connect logger to router so all log messages are published
  connectLoggerToRouter(routerManager);

  // Buffer manager
  const bufferManager = new BufferManager();
  await bufferManager.init();

  // Connect to database
  const PG_CONNECT_TIMEOUT_MS = Number(Deno.env.get('POSTGRES_CONNECT_TIMEOUT_MS') ?? 60_000);
  logger.info('Connecting to database...', { url: POSTGRES_URL.replace(/:[^:@]+@/, ':****@') });
  const pgPool = new PriorityPool({
    connectionString: POSTGRES_URL,
    // Connections background work may never hold, so an interactive command
    // never queues behind the crawl. See `src/lib/pg/priority-pool.ts` for the
    // admission rule. Zero restores plain first-come-first-served.
    reserved: Number(Deno.env.get('POSTGRES_POOL_RESERVED') ?? 4),
    // node-postgres defaults to 10. Every store operation holds a connection for its
    // duration, so anything running work in parallel — `import-files --concurrency`, the
    // pipeline engine's concurrent steps — queues on the pool long before postgres itself
    // becomes the constraint, and that queueing looks exactly like the database being slow.
    max: Number(Deno.env.get('POSTGRES_POOL_MAX') ?? 20),
    // A request that cannot get a connection in this long fails instead of
    // waiting: a starved pool then shows up as errors rather than as the whole
    // process hanging.
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    // The session TimeZone, pinned to the same zone this process renders in. `birth_time` is
    // a timestamptz, so `to_char(n.birth_time, 'YYYY')` in `stores/pg/query.ts` reads it in
    // whatever the session says — while the in-memory aggregate buckets from local date parts
    // in `vfs/query-eval.ts`. Two zones means the two stores answer differently for a file
    // born either side of midnight on 31 December, which is a discrepancy no test would catch
    // unless it happened to run in the wrong hour.
    //
    // A startup parameter rather than a `SET TIME ZONE` on the pool's connect event: it is
    // applied before the connection can serve a query, so there is no window where one runs
    // against the server default.
    options: `-c timezone=${SYSTEM_TIME_ZONE}`,
  });

  // Reported in the `runtime` metrics series beside event-loop lag, which is where the two
  // halves of "the shell feels slow" are read together: lag says the main thread was late,
  // the pool counters say it was waiting for a connection.
  registerPoolStats(() => pgPool.poolStats());

  // LISTEN/NOTIFY connections only. Four registries — log, queue, pool, track — each hold
  // one for their whole lifetime to receive notifications, and a connection in that state
  // cannot serve a query, so on the shared pool they would be four of twenty permanently gone.
  // Small and fixed: the count is a property of how many registries exist, not of load.
  const pgListenPool = new Pool({
    connectionString: POSTGRES_URL,
    max: Number(Deno.env.get('POSTGRES_LISTEN_POOL_MAX') ?? 4),
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    options: `-c timezone=${SYSTEM_TIME_ZONE}`,
  });
  // As in `PriorityPool`: a connection lost while idle is reported here, never thrown.
  pgListenPool.on('error', (err: Error) => logger.warn('idle listen connection lost', { error: err.message }));

  // A new PostgreSQL image brings new extension libraries; the database takes their SQL side here,
  // before anything uses it.
  await updateExtensions(POSTGRES_URL);

  // Create root VFS
  logger.info('Initializing VFS...');
  const vfs = new LocalNodeVFS(new InMemoryStore({}), routerManager, {
    router: new RouterRegistry({ router: routerManager }),
  });
  await vfs.initialize();

  // System core
  const systemCore: SystemCore = {
    bufferManager,
    routerManager,
    vfs,
    pgPool,
    pgListenPool,
  };

  // Execution manager
  logger.info('Initializing exec manager...');
  const execManager = new ExecManager(systemCore);
  await execManager.init();
  systemCore.execManager = execManager;

  // Shell manager
  logger.info('Initializing shell manager...');
  const shellManager = new ShellManager({ cem: execManager, vfs, bufferManager });
  await shellManager.init();
  systemCore.shellManager = shellManager;

  // Service manager
  logger.info('Initializing service manager...');
  const serviceManager = new ServiceManager({
    vfs,
    cem: execManager,
    bufferManager,
    servicesPath: SERVICES_PATH,
    logsPath: LOGS_PATH,
  });
  await serviceManager.init();
  systemCore.serviceManager = serviceManager;

  // System shell
  logger.info('Initializing system shell...');
  const systemShell = await shellManager.createSystemShell({
    sessionPath: '!/.session-system',
    env: settingsFromEnv(),
  });

  // Where `mod install` puts modules. A deployment mounts a folder of the host here so the
  // installs outlive the container; without one the folder is the container's own.
  const moduleInstallPath = Deno.env.get('MODULE_INSTALL_PATH') || resolve(Deno.cwd(), './modules-installed');
  await Deno.mkdir(moduleInstallPath, { recursive: true });

  // Run init scripts
  await boot(systemShell, {
    mode: 'primary',
    env: {
      EXTERNAL_FILE_ROOT_PATH: Deno.env.get('FILE_ROOT_PATH') || resolve(Deno.cwd(), './files'),
      // Fast, regenerable renditions (thumbnails/crops/transcodes). Defaults to
      // the durable root, so a single-disk install has one root.
      EXTERNAL_VOLATILE_FILE_ROOT_PATH: Deno.env.get('VOLATILE_FILE_ROOT_PATH') || Deno.env.get('FILE_ROOT_PATH') ||
        resolve(Deno.cwd(), './files'),
      EXTERNAL_FILE_TMP_PATH: Deno.env.get('FILE_TMP_PATH') || '/tmp',
      EXTERNAL_DEV_MODULES_PATH: Deno.env.get('DEV_MODULES_PATH') || resolve(Deno.cwd(), './modules'),
      EXTERNAL_MODULE_INSTALL_PATH: moduleInstallPath,
      INSTALL_MODULES: Deno.env.get('INSTALL_MODULES') ?? '',
      EXTERNAL_DOCS_PATH: Deno.env.get('DOCS_PATH') || resolve(Deno.cwd(), './docs/user'),
      // Every CFG_* the container was launched with, forwarded wholesale.
      //
      // Shells take their environment from /etc/bashrc rather than from this
      // process, and an external tool takes it from the shell that spawned it,
      // so a setting that stops here reaches nothing. Forwarding the whole
      // prefix rather than naming them one at a time is what lets a new setting
      // be added without editing boot: `config publish` then writes them into
      // /etc/environment so a service restarted later still sees them.
      ...settingsFromEnv(),
    },
  });

  // Release startup queue — all subscribers are now registered
  routerManager.release();

  // PID 1 does not get an application shutdown path for free. Without signal
  // listeners Podman terminates Deno immediately, so ServiceManager never tells
  // pool workers to restore their claimed steps and release their leases. Keep
  // the process alive on the signal while services stop cooperatively.
  const signal = await waitForShutdownSignal();
  logger.info('Shutdown requested', { signal });

  try {
    await serviceManager.dispose();
  } catch (error) {
    logger.error('Failed to stop services during shutdown', error);
  }
  try {
    await execManager.dispose();
  } catch (error) {
    logger.error('Failed to stop commands during shutdown', error);
  }
  try {
    await shellManager.dispose();
  } catch (error) {
    logger.error('Failed to close shells during shutdown', error);
  }
  try {
    await vfs.dispose();
  } catch (error) {
    logger.error('Failed to dispose VFS during shutdown', error);
  }
  try {
    await routerManager.dispose();
  } catch (error) {
    logger.error('Failed to dispose router during shutdown', error);
  }
  try {
    await bufferManager.dispose();
  } catch (error) {
    logger.error('Failed to dispose buffers during shutdown', error);
  }
  await Promise.allSettled([pgListenPool.end(), pgPool.end()]);
  logger.info('Shutdown complete');
}

/** Resolve once and restore the default signal disposition immediately. */
const waitForShutdownSignal = (): Promise<ShutdownSignal> =>
  new Promise((resolve) => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const finish = (signal: ShutdownSignal) => {
      for (const [name, listener] of listeners) Deno.removeSignalListener(name, listener);
      resolve(signal);
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      const listener = () => finish(signal);
      listeners.set(signal, listener);
      Deno.addSignalListener(signal, listener);
    }
  });

// Error handling
if (import.meta.main) {
  try {
    await main();
    // This process is the container's PID 1. Some third-party resources can
    // keep Deno's event loop alive even after every managed service and pool
    // has been disposed, so terminate explicitly once cleanup has completed.
    Deno.exit(0);
  } catch (error) {
    logger.error('Fatal error:', error);
    Deno.exit(1);
  }
}
