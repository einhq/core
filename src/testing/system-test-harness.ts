/**
 * System Test Harness
 *
 * Starts a primary instance (HTTP + SSH) for end-to-end testing. Provides
 * SSH/SFTP client factories.
 */

import { basename, dirname, join } from '@std/path';
import { Client, generateKeyPair, type SFTP } from 'ssh2';
import { type Access, ADMIN_ACCESS, ADMIN_GID, ADMIN_UID, ADMIN_USERNAME } from '../lib/access/mod.ts';
import { setAccountPassword } from '../lib/auth/account-password.ts';
import { BufferManager, type BufferManagerIf } from '../managers/buffer/mod.ts';
import { ExecManager, type ExecutionManager } from '../managers/exec/mod.ts';
import { RouterManager } from '../managers/router/mod.ts';
import { ServiceManager } from '../managers/services/mod.ts';
import { ShellManager } from '../managers/shell/mod.ts';
import { Shell } from '../managers/shell/shell.ts';
import { boot } from '../init/boot.ts';
import { contributionsOf, registerContributions, unregisterContributions } from '../lib/contributions/registry.ts';
import { ensureArchiveRoots } from '../lib/contributions/roots.ts';
import type { SystemCore } from '../system-core.ts';
import { expandModuleDeps } from './module-deps.ts';
import { LIB_SOURCE_DIR, MODULES_DIR, moduleSourceDir } from '../modules/repo.ts';
import { startHttpServer } from '../servers/http/http-server.ts';
import { SSHServer } from '../servers/ssh/mod.ts';
import { LocalNodeVFS, type NodeVFS } from '../vfs/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../vfs/types/session.ts';
import type { UserAttrs } from '../vfs/types/user.ts';
import {
  ARCHIVE_PATH,
  BIN_PATH,
  ETC_PATH,
  GROUPS_PATH,
  HOME_MODE,
  homePath,
  HOMES_PATH,
  LIB_PATH,
  LINKS_PATH,
  LOGS_PATH,
  MOD_PATH,
  pathEnv,
  SERVICES_PATH,
  SESSIONS_PATH,
  TAGS_ROOT,
  TEMP_PATH,
  USERS_PATH,
} from '../lib/paths.ts';
import { createMemoryTestVfs } from './memory-vfs.ts';
import { createPgTestVfs, type PgTestVfsOptions } from './pg-vfs.ts';
import { ShellClient } from './shell-client.ts';

const ADMIN_PASSWORD = 'admin';

/**
 * The environment a test instance's modules ask for: each module's own `test/environment.json`
 * (variable to value) for the modules a test loads and what they depend on, under every `CFG_*`
 * the test process was started with — how `make container-test` points an instance at real
 * services. A module uses it to keep a test away from a service nothing answers for in the fast
 * tier, say.
 *
 * It is handed to boot below, so `config publish` writes it into /etc/environment, which the
 * services and a pool worker source through /etc/bashrc.
 */
const testEnvironment = (modules: string[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of modules) {
    try {
      Object.assign(env, JSON.parse(Deno.readTextFileSync(join(MODULES_DIR, name, 'test', 'environment.json'))));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const [key, value] of Object.entries(Deno.env.toObject())) if (key.startsWith('CFG_')) env[key] = value;
  return env;
};

/**
 * scrypt at its production cost is ~150 ms of CPU per hash, a login verifies by
 * hashing again, and the suite creates users and logs in constantly — on the
 * critical path of every file that boots, logs in, and tears down. The cost is written into the
 * hash, so this reaches every verify of a hash this instance made, whether by
 * `createUser` below or by `user-passwd` in the test boot, which reads it from the system shell's
 * launch environment. See
 * `src/lib/auth/password.ts`.
 */
const passwordEnv: Record<string, string> = {
  CFG_PASSWORD_HASH_LOGN: '10',
};

const primaryEnv: Record<string, string> = {
  ...pathEnv(),
  ADMIN_USERNAME: 'admin',
  ADMIN_UID: '0',
  ADMIN_GID: '0',
  COOKIE_NAME: 'ein-test',
  ...passwordEnv,
};

export type SystemTestOptions = {
  httpPort?: number;
  sshPort?: number;
  ssh?: boolean;
  /** run the full boot sequence (instance mode `test`) with ShellManager + ServiceManager */
  boot?: boolean;
  /** back the file registry with this disk directory instead of memory (needed when external tools must read node content) */
  fileRoot?: string;
  /** mount the data VFS at `/` under a router-only root, as the primary instance does */
  rootMount?: boolean;
  /** keep the nodes, the db file tier and the queues in PostgreSQL tables instead of memory (not with `fileRoot` or `rootMount`) */
  pg?: PgTestVfsOptions;
  /** extra repo modules (by name under modules/) to mount with their bin on PATH; in boot mode they get `mod setup` */
  modules?: string[];
  /**
   * Extra environment for the boot shell, and therefore for every service it
   * starts.
   *
   * This is how a test tunes the pipeline engine, which takes its limits from
   * `cmd.env`: per harness, unlike the process environment that the fast tier's
   * parallel files share.
   */
  env?: Record<string, string>;
  verbose?: boolean;
};

export type PrimaryContext = {
  vfs: NodeVFS;
  cem: ExecutionManager;
  bufferManager: BufferManagerIf;
  /** The relay registries bind to: what a test publishes on reaches a bound log, queue or track. */
  routerManager: RouterManager;
  shell: Shell;
  httpPort: number;
  sshPort: number;
  baseUrl: string;
};

export type SSHExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export class SystemTestHarness {
  private primaryVfs?: LocalNodeVFS;
  private primaryRouterManager?: RouterManager;
  private primaryBufferManager?: BufferManager;
  private primaryShell?: Shell;
  private sshServer?: SSHServer;
  private httpAbortController?: AbortController;
  private httpServerPromise?: Promise<void>;
  private shellManager?: ShellManager;
  serviceManager?: ServiceManager;

  primary?: PrimaryContext;

  /** Modules whose contributions `startPrimary` registered outside boot, dropped in `stop()`. */
  private contributionOwners: string[] = [];

  constructor(private options: SystemTestOptions = {}) {}

  async startPrimary(): Promise<PrimaryContext> {
    // A test naming `media` gets `media` and everything media declares it needs, in dependency
    // order — otherwise `mod setup` refuses the install and the failure looks unrelated to the
    // test. Expanding here rather than making tests spell out transitive deps keeps `modules:`
    // meaning "what this test is about".
    const modules = expandModuleDeps(this.options.modules ?? []);
    // `primaryEnv` already carries `$BIN_PATH:$CORE_BIN_PATH` from `pathEnv()`;
    // only the extra test modules' bin directories are appended, which is the
    // one thing a test instance has that a real one does not.
    const env = {
      ...primaryEnv,
      ...testEnvironment(modules),
      PATH: [primaryEnv.PATH, ...modules.map((m) => `${MOD_PATH}/${m}/bin`)].join(':'),
      ...this.options.env,
    };

    const routerManager = new RouterManager();
    await routerManager.init();
    this.primaryRouterManager = routerManager;

    const bufferManager = new BufferManager();
    await bufferManager.init();
    this.primaryBufferManager = bufferManager;

    const vfs = this.options.pg ? await createPgTestVfs(routerManager, this.options.pg) : (await createMemoryTestVfs(routerManager, {
      fileRoot: this.options.fileRoot,
      rootMount: this.options.rootMount,
    })).vfs;
    this.primaryVfs = vfs;

    const sysCore: SystemCore = { vfs, bufferManager, routerManager };
    const cem = new ExecManager(sysCore);
    await cem.init();
    sysCore.execManager = cem;

    let shell: Shell;

    if (this.options.boot) {
      // Full boot: managers + init scripts (mode `test`), like primary-main.ts
      const shellManager = new ShellManager({ cem, vfs, bufferManager });
      await shellManager.init();
      sysCore.shellManager = shellManager;
      this.shellManager = shellManager;

      const serviceManager = new ServiceManager({
        vfs,
        cem,
        bufferManager,
        servicesPath: SERVICES_PATH,
        logsPath: LOGS_PATH,
      });
      await serviceManager.init();
      sysCore.serviceManager = serviceManager;
      this.serviceManager = serviceManager;

      // The boot shell is what `service start-all` hands to every service,
      // so this is the only route by which a test can configure one, a pool
      // worker included.
      const settings = { ...testEnvironment(modules), ...passwordEnv, ...this.options.env };
      // Launched with them, as primary-main launches it with the container's: `config publish`
      // publishes what the shell was launched with.
      shell = await shellManager.createSystemShell({ sessionPath: '!/.session-system', env: settings });
      this.primaryShell = shell;

      await boot(shell, {
        mode: 'test',
        env: {
          EXTERNAL_DEV_MODULES_PATH: MODULES_DIR,
          EXTERNAL_DOCS_PATH: join(import.meta.dirname!, 'fixtures', 'guide'),
          TEST_MODULES: modules.join(' '),
          ...settings,
        },
      });
    } else {
      // The skeleton a non-booted instance needs, at the paths `pathEnv()` names.
      const ensurePath = async (path: string, mode = 0o755) => {
        let parent = '/';
        for (const segment of path.split('/').filter(Boolean)) {
          await vfs.ensure(ADMIN_ACCESS, 'directory', parent, segment, { props: { mode } });
          parent = parent === '/' ? `/${segment}` : `${parent}/${segment}`;
        }
      };

      for (const dir of [TEMP_PATH, SESSIONS_PATH, LINKS_PATH, HOMES_PATH, USERS_PATH, BIN_PATH, ETC_PATH, GROUPS_PATH, MOD_PATH]) {
        await ensurePath(dir);
      }
      // The archive and core's label tree, as 02_archive.sh makes them at boot; the other roots are
      // the modules' (below).
      await ensurePath(ARCHIVE_PATH, 0o775);
      await ensureArchiveRoots(vfs, [TAGS_ROOT]);
      await vfs.update(ADMIN_ACCESS, TEMP_PATH, { props: { mode: 0o777 } });

      shell = await this.createSystemShell(cem, vfs, bufferManager, env);
      this.primaryShell = shell;

      await shell.runAndCapture(`mount ${BIN_PATH} command`);

      await ensurePath(LIB_PATH);
      await shell.runAndCapture(`mount ${LIB_PATH} filesystem "filesPath=${LIB_SOURCE_DIR},readonly"`);
      for (const name of modules) {
        await vfs.ensure(ADMIN_ACCESS, 'directory', MOD_PATH, name, { props: { mode: 0o755 } });
        await shell.runAndCapture(`mount ${MOD_PATH}/${name} filesystem "filesPath=${moduleSourceDir(name)},readonly"`);
      }

      // What `mod setup` would register in memory and a mounted module needs to work: its
      // completable node types and the archive roots it creates — without them a non-boot
      // instance would differ from a real one in exactly the location most command tests operate.
      // Dropped again in `stop()`.
      for (const name of modules) {
        let manifest: Parameters<typeof contributionsOf>[0];
        try {
          manifest = JSON.parse(await Deno.readTextFile(join(moduleSourceDir(name), 'mod.json')));
        } catch (error) {
          // A test may still name a module since removed; mounting it above did nothing either.
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        const contributions = contributionsOf(manifest);
        if (registerContributions(name, contributions)) await ensureArchiveRoots(vfs, contributions.roots ?? []);
        this.contributionOwners.push(name);
      }

      await this.createUser(vfs, 'admin', ADMIN_PASSWORD, ADMIN_UID, ADMIN_GID);
    }

    let sshPort = 0;
    if (this.options.ssh !== false) {
      const kp = await generateKeyPair('ed25519');
      const sshServer = new SSHServer({
        port: this.options.sshPort ?? 0,
        hostKey: kp.private,
        cem,
        vfs,
        bufferManager,
        env,
      });
      sshPort = await sshServer.start();
      this.sshServer = sshServer;
    }

    const ac = new AbortController();
    this.httpAbortController = ac;
    const listening = Promise.withResolvers<number>();
    this.httpServerPromise = startHttpServer({
      port: this.options.httpPort ?? 0,
      signal: ac.signal,
      cem,
      vfs,
      bufferManager,
      rootPath: '/',
      env,
      onListen: (info) => listening.resolve(info.port),
    }).catch((err) => {
      listening.reject(err);
      throw err;
    });
    const httpPort = await listening.promise;

    routerManager.release();

    this.primary = {
      vfs,
      cem,
      bufferManager,
      routerManager,
      shell,
      httpPort,
      sshPort,
      baseUrl: `http://localhost:${httpPort}`,
    };

    return this.primary;
  }

  /** Create an HTTP session node and return the Cookie header for it (admin access by default) */
  async createHttpSession(access?: Access): Promise<{ cookie: string; sessionPath: string }> {
    if (!this.primary) throw new Error('primary not started');

    const name = crypto.randomUUID().replaceAll('-', '');
    const secret = crypto.randomUUID().replaceAll('-', '');
    const sessionPath = `${SESSIONS_PATH}/session-${name}`;

    await this.primary.vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, SESSIONS_PATH, `session-${name}`, {
      props: { mode: 0o700 },
      attrs: {
        secret,
        access: access ?? { uid: ADMIN_UID, gid: ADMIN_GID, gids: [ADMIN_GID] },
        env: {},
        createdAt: Date.now(),
        lastActivity: Date.now(),
        expiresSec: 60 * 60,
      },
    });

    return { cookie: `${primaryEnv.COOKIE_NAME}=${name}.${secret}`, sessionPath };
  }

  /** Connect a ShellClient to the primary's HTTP API shell, logged in as admin by default */
  async createShellClient(opts?: { username?: string; password?: string; login?: boolean }): Promise<ShellClient> {
    if (!this.primary) throw new Error('primary not started');

    const client = await ShellClient.connect(this.primary.baseUrl);

    if (opts?.login !== false) {
      const username = opts?.username ?? ADMIN_USERNAME;
      const password = opts?.password ?? ADMIN_PASSWORD;
      const result = await client.exec(`login ${username} ${password}`);
      if (!result.success) {
        client.close();
        throw new Error(`login failed for ${username}: ${result.error}`);
      }
    }

    return client;
  }

  /** Connect an SSH client to the primary's SSH server */
  async connectSSH(opts?: { username?: string; password?: string }): Promise<Client> {
    if (!this.primary) throw new Error('primary not started');
    if (!this.sshServer) throw new Error('ssh server not started (ssh: false)');

    const client = new Client();

    const ready = new Promise<void>((resolve, reject) => {
      client.on('ready', () => resolve());
      client.on('error', (err: Error) => reject(err));
    });

    await client.connect({
      host: 'localhost',
      port: this.primary.sshPort,
      username: opts?.username ?? 'admin',
      password: opts?.password ?? ADMIN_PASSWORD,
      algorithms: { serverHostKey: ['ssh-ed25519'] },
    });

    await ready;
    return client;
  }

  /** Connect an SFTP client to the primary's SSH server */
  async connectSFTP(opts?: { username?: string; password?: string }): Promise<{ client: Client; sftp: SFTP }> {
    const client = await this.connectSSH(opts);
    const sftp = await client.sftp();
    return { client, sftp };
  }

  /** Run a command over SSH and collect output */
  async runSSH(command: string, opts?: { username?: string; password?: string }): Promise<SSHExecResult> {
    const client = await this.connectSSH(opts);

    try {
      const channel = await client.exec(command);
      const decoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let stdout = '';
      let stderr = '';

      const stdoutDone = channel.readable.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            stdout += decoder.decode(chunk, { stream: true });
          },
        }),
      ).catch(() => {});

      const stderrStream = channel.stderr as ReadableStream<Uint8Array>;
      const stderrDone = stderrStream.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            stderr += stderrDecoder.decode(chunk, { stream: true });
          },
        }),
      ).catch(() => {});

      const code = await new Promise<number>((resolve) => {
        let exitCode = 0;
        channel.on('exit-status', (c: number) => {
          exitCode = c;
        });
        channel.on('close', () => {
          resolve(exitCode);
        });
      });

      await Promise.all([stdoutDone, stderrDone]);

      return { stdout, stderr, code };
    } finally {
      client.end();
    }
  }

  async stop(): Promise<void> {
    for (const owner of this.contributionOwners.splice(0)) unregisterContributions(owner);

    if (this.serviceManager) {
      try {
        await this.serviceManager.stopAll();
      } catch { /* ignore */ }
      try {
        await this.serviceManager.dispose();
      } catch { /* ignore */ }
    }

    if (this.shellManager) {
      try {
        await this.shellManager.dispose();
      } catch { /* ignore */ }
    }

    if (this.sshServer) {
      await this.sshServer.stop();
    }

    if (this.httpAbortController) {
      this.httpAbortController.abort();
      try {
        await this.httpServerPromise;
      } catch { /* expected abort error */ }
    }

    if (this.primaryShell) {
      try {
        await this.primaryShell.close();
      } catch { /* ignore */ }
    }
    if (this.primaryVfs) {
      try {
        await this.primaryVfs.dispose();
      } catch { /* ignore */ }
    }
    if (this.primaryRouterManager) {
      try {
        await this.primaryRouterManager.dispose();
      } catch { /* ignore */ }
    }
    if (this.primaryBufferManager) {
      try {
        await this.primaryBufferManager.dispose();
      } catch { /* ignore */ }
    }
  }

  private async createSystemShell(
    cem: ExecutionManager,
    vfs: NodeVFS,
    bufferManager: BufferManagerIf,
    env: Record<string, string>,
  ): Promise<Shell> {
    const sessionPath = '!/.session-system';

    await vfs.ensure<SessionAttrs>(
      ADMIN_ACCESS,
      NODE_TYPE_SESSION,
      dirname(sessionPath),
      basename(sessionPath),
      {
        props: { mode: 0o700 },
        attrs: {
          secret: crypto.randomUUID().replaceAll('-', ''),
          access: {
            uid: ADMIN_UID,
            gid: ADMIN_GID,
            gids: [ADMIN_GID],
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
          env: {
            ...env,
            USER: ADMIN_USERNAME,
            HOME: homePath(ADMIN_USERNAME),
          },
        },
      },
    );

    const shell = new Shell({
      cem,
      vfs,
      bufferManager,
      sessionPath,
      env: {
        ...env,
        USER: ADMIN_USERNAME,
        HOME: homePath(ADMIN_USERNAME),
      },
    });
    await shell.open();

    if (this.options.verbose) {
      const decoder = new TextDecoder();
      const stdout = await shell.openIOHandle('stdout', 'r');
      stdout.readable.pipeTo(
        new WritableStream<Uint8Array>({
          write(line) {
            console.log('[stdout]', decoder.decode(line).trimEnd());
          },
        }),
      ).catch(() => {});

      const stderr = await shell.openIOHandle('stderr', 'r');
      stderr.readable.pipeTo(
        new WritableStream<Uint8Array>({
          write(line) {
            console.error('[stderr]', decoder.decode(line).trimEnd());
          },
        }),
      ).catch(() => {});
    }

    return shell;
  }

  private async createUser(vfs: NodeVFS, username: string, password: string, uid: number, gid: number): Promise<void> {
    // The account the administrator's, as `user-create` makes it, and the home the user's.
    const accountPath = join(USERS_PATH, username);
    await vfs.create<UserAttrs>(ADMIN_ACCESS, 'user', USERS_PATH, username, {
      props: { mode: 0o755 },
      attrs: { name: username, uid, gid },
    });
    await vfs.ensure(ADMIN_ACCESS, 'directory', HOMES_PATH, username, { props: { mode: HOME_MODE, uid, gid } });

    await setAccountPassword(vfs, ADMIN_ACCESS, accountPath, password, primaryEnv);
  }
}

/**
 * Create a system test harness with convenient setup/teardown
 */
export function createSystemTestContext(options?: SystemTestOptions) {
  const harness = new SystemTestHarness(options);

  return {
    harness,

    async setup(): Promise<{ primary: PrimaryContext }> {
      const primary = await harness.startPrimary();
      return { primary };
    },

    async teardown(): Promise<void> {
      await harness.stop();
    },
  };
}
