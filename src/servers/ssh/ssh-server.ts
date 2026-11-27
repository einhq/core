/**
 * SSH Server
 *
 * Provides SSH access to the EiN VFS with terminal and SFTP support.
 * Uses the ssh2 package for SSH protocol handling.
 */

import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { type Channel, type Connection, type ConnectionInfo, type PKAuthContext, Server, type ServerAuthContext, type Session, SFTP, type StderrWritable } from 'ssh2';
import { type Access, ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { accountByLoginName } from '../../lib/auth/email.ts';
import { sshPasswordsAllowed } from '../../lib/config/mod.ts';
import { userAccess } from '../../lib/auth/member-gids.ts';
import { passwordSignIn, type SignInAccount, SignInFailedError } from '../../lib/auth/account-password.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { homePath, USERS_PATH } from '../../lib/paths.ts';
import type { BufferManagerIf } from '../../managers/buffer/mod.ts';
import type { ExecutionManager } from '../../managers/exec/mod.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import { InteractiveShell } from '../../managers/shell/interactive-shell.ts';
import { Shell } from '../../managers/shell/shell.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import { type AccessInput, type EventSubscription, type Node, type NodeEvent, type NodeVFS, recordAccess } from '../../vfs/mod.ts';
import { StepTimer } from '../../lib/metrics/mod.ts';
import type { SessionAttrs } from '../../vfs/types/session.ts';
import { isUserNode, loginRefusal, NODE_TYPE_USER, type UserAttrs } from '../../vfs/types/user.ts';
import { findAuthorizedKey } from './authorized-keys.ts';
import { SFTPHandler } from './sftp-handler.ts';

const logger = createLogger('ssh-server');

/** What the server calls itself; see the `ident` option below. */
const SERVER_IDENT = 'OpenSSH_compatible EiN';

/** Connections the server keeps at once, signed in or not. */
const MAX_CONNECTIONS = 1000;

export type SSHServerConfig = {
  port: number;
  hostKey: string;
  cem: ExecutionManager;
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  env: Record<string, string>;
};

type AuthenticatedUser = {
  access: Access;
  username: string;
  method: 'password' | 'publickey';
};

/** The SSH servers running in this process, which `endSshConnectionsOf` reaches. */
const liveServers = new Set<SSHServer>();

/**
 * End every SSH connection signed in as `uid`, on every server of this process, but those whose
 * access `where` refuses: a connection's access names it by its `sid`. Returns how many it ended.
 */
export function endSshConnectionsOf(uid: number, where: (access: Access) => boolean = () => true): number {
  let ended = 0;
  for (const server of liveServers) ended += server.endConnectionsWhere((user) => user.access.uid === uid && where(user.access));
  return ended;
}

export class SSHServer {
  private server: Server;
  private connections = new Map<string, Connection>();
  /** Who each authenticated connection signed in as, by connection id. */
  private users = new Map<string, AuthenticatedUser>();
  private userWatch?: EventSubscription;

  constructor(private config: SSHServerConfig) {
    this.server = new Server(
      {
        hostKeys: [this.config.hostKey],
        // OpenSSH's client tells a server that calls itself OpenSSH when it can write no more of a
        // command's output (`ssh host cmd | head`), and otherwise waits for the command for good
        ident: SERVER_IDENT,
        debug: (msg: string) => {
          logger.debug('SSH2', { msg });
        },
        algorithms: {
          // No MODP Diffie-Hellman: it runs on the event loop, and a client that
          // has not signed in could choose the 8192-bit group over and over
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
          ],
        },
      },
      (client: Connection, info: ConnectionInfo) => this.handleConnection(client, info),
    );
    // Connections still signing in have ssh2's limits: 120 s to authenticate, 100
    // at once and 10 from one address; this bounds all of them
    this.server.maxConnections = MAX_CONNECTIONS;
    // A failed accept, after which the server asks again, or a connection it could not set up
    this.server.on('error', (err: Error) => {
      logger.warn('SSH server error', { error: err.message });
    });
  }

  async start(): Promise<number> {
    this.userWatch = await this.watchUsers();
    await this.server.listen(this.config.port, '0.0.0.0');
    liveServers.add(this);
    const port = this.server.address()?.port ?? this.config.port;
    logger.info('SSH server listening', { port });
    return port;
  }

  async stop(): Promise<void> {
    liveServers.delete(this);
    await this.userWatch?.unsubscribe();
    this.userWatch = undefined;
    this.server.close();
  }

  /**
   * End every connection of an account that is disabled or deleted. The check
   * at sign-in cannot reach a connection that is already open, and the shells,
   * exec channels and SFTP sessions on it all act as the account.
   */
  private async watchUsers(): Promise<EventSubscription | undefined> {
    if (!this.config.vfs.subscribe) return undefined;
    return await this.config.vfs.subscribe<UserAttrs>(() => ADMIN_ACCESS, (event) => {
      if (dirname(event.path) !== USERS_PATH || !endsAccount(event)) return;
      this.endConnectionsOf(basename(event.path));
    }, {
      pathPrefix: USERS_PATH,
      recursive: false,
      nodeTypes: [NODE_TYPE_USER],
      eventTypes: ['updated', 'deleted'],
    });
  }

  private endConnectionsOf(username: string): void {
    this.endConnectionsWhere((user) => user.username === username, 'a disabled account');
  }

  /** End every authenticated connection whose user `ends` accepts; returns how many. */
  endConnectionsWhere(ends: (user: AuthenticatedUser) => boolean, why = 'a signed-out account'): number {
    let ended = 0;
    for (const [connId, user] of this.users) {
      if (!ends(user)) continue;
      logger.info(`ending SSH connection of ${why}`, { connId, username: user.username });
      this.connections.get(connId)?.end();
      ended++;
    }
    return ended;
  }

  private handleConnection(
    client: Connection,
    info: ConnectionInfo,
  ): void {
    const connId = ulid();
    this.connections.set(connId, client);
    let authenticatedUser: AuthenticatedUser | null = null;
    // What the connection's writes and its access-log records name it by.
    const sid = `ssh-${connId}`;
    const record = (input: Omit<AccessInput, 'sid' | 'from' | 'via'>) => recordAccess(this.config.vfs, { ...input, sid, from: info.ip, via: 'ssh' });

    logger.info('SSH connection', { connId, ip: info.ip });

    client.on('authentication', async (ctx: ServerAuthContext) => {
      try {
        // Read at each attempt, so turning passwords off needs no restart
        const passwords = await sshPasswordsAllowed(this.config.vfs);
        const offered = passwords ? ['publickey', 'password'] : ['publickey'];
        if (ctx.method === 'password' && passwords) {
          const user = await this.authenticatePassword(
            ctx.username,
            (ctx as ServerAuthContext & { password: string }).password,
            info.ip,
            sid,
          );
          if (user) {
            authenticatedUser = user;
            ctx.accept();
            return;
          }
        } else if (ctx.method === 'publickey') {
          const pk = ctx as PKAuthContext;
          const user = await this.authenticateKey(ctx.username, pk, sid);
          if (user) {
            // Without a signature the client only asks whether this key would
            // do; accept() answers PK_OK and the signed request follows
            if (pk.signature) authenticatedUser = user;
            ctx.accept();
            return;
          }
        }
        ctx.reject(offered);
      } catch (err) {
        logger.error('authentication error', {
          error: (err as Error).message,
        });
        ctx.reject();
      }
    });

    client.on('ready', () => {
      logger.info('SSH client authenticated', {
        connId,
        username: authenticatedUser?.username,
      });
      if (authenticatedUser) {
        this.users.set(connId, authenticatedUser);
        void record({ event: 'sign-in', uid: authenticatedUser.access.uid, method: authenticatedUser.method });
      }

      client.on('session', async (accept, reject) => {
        if (!await this.mayStillAct(authenticatedUser!)) {
          logger.info('ending SSH connection of a disabled or deleted account', { connId, username: authenticatedUser?.username });
          reject();
          client.end();
          return;
        }
        const session = accept();
        if (!session) return;
        this.handleSession(client, session, authenticatedUser!, connId, info.ip);
      });
    });

    client.on('close', () => {
      this.connections.delete(connId);
      this.users.delete(connId);
      if (authenticatedUser) void record({ event: 'sign-out', uid: authenticatedUser.access.uid });
      logger.info('SSH client disconnected', { connId });
    });

    client.on('error', (err: Error) => {
      logger.error('SSH client error', { connId, error: err.message });
    });
  }

  /**
   * The account `typed` names, by username or e-mail address (`accountByLoginName`), when it may sign
   * in by key: not disabled, no password reset pending. Null otherwise, whatever the key.
   */
  private async keySignInAccount(typed: string): Promise<SignInAccount | null> {
    const account = await accountByLoginName(this.config.vfs, typed).catch(() => undefined);
    if (!account) return null;

    const refusal = loginRefusal(account.userNode.attrs);
    if (refusal) {
      logger.debug(`publickey auth blocked: ${refusal}`, { username: account.username });
      return null;
    }
    return account;
  }

  /**
   * Whether the account a connection signed in as may still act: it is there, with the uid it
   * signed in with, and not disabled. Asked as each shell, command or SFTP session opens, behind
   * the watch that ends the connections of a disabled or deleted account (`watchUsers`).
   */
  private async mayStillAct(user: AuthenticatedUser): Promise<boolean> {
    const userNode = await this.config.vfs.get<UserAttrs>(ADMIN_ACCESS, join(USERS_PATH, user.username)).catch(() => undefined);
    return !!userNode && isUserNode(userNode) && userNode.attrs.uid === user.access.uid && userNode.attrs.inactive !== true;
  }

  private async authenticatedAs(username: string, userNode: Node<UserAttrs>, method: AuthenticatedUser['method'], sid: string): Promise<AuthenticatedUser> {
    return {
      access: { ...await userAccess(this.config.vfs, ADMIN_ACCESS, username, userNode), sid },
      username,
      method,
    };
  }

  /**
   * A key from the user's `~/.ssh/authorized_keys`. Asked twice per login by a
   * normal client: first without a signature ("would this key do?"), then with
   * one, which is verified here against the listed key.
   */
  private async authenticateKey(username: string, pk: PKAuthContext, sid: string): Promise<AuthenticatedUser | null> {
    try {
      const account = await this.keySignInAccount(username);
      if (!account) return null;

      const found = await findAuthorizedKey(this.config.vfs, homePath(account.username), account.userNode.attrs.uid, pk.key.data);
      if (!found) return null;
      if ('refused' in found) {
        logger.warn('key auth refused', { username: account.username, reason: found.refused });
        return null;
      }

      if (pk.signature) {
        const valid = await found.key.verify(pk.blob!, pk.signature, pk.hashAlgo);
        if (valid !== true) return null;
      }
      return await this.authenticatedAs(account.username, account.userNode, 'publickey', sid);
    } catch (err) {
      logger.debug('key auth failed', { username, error: (err as Error).message });
      return null;
    }
  }

  private async authenticatePassword(
    username: string,
    password: string,
    from: string | undefined,
    sid: string,
  ): Promise<AuthenticatedUser | null> {
    try {
      const account = await passwordSignIn(this.config.vfs, username, password, { env: this.config.env, from });
      return await this.authenticatedAs(account.username, account.userNode, 'password', sid);
    } catch (err) {
      logger.debug('password auth failed', {
        username,
        error: (err as Error).message,
      });
      await recordAccess(this.config.vfs, {
        event: 'sign-in-failed',
        uid: err instanceof SignInFailedError ? err.uid : undefined,
        reason: (err as Error).message,
        method: 'password',
        sid,
        from,
        via: 'ssh',
      });
    }
    return null;
  }

  private handleSession(
    client: Connection,
    session: Session,
    user: AuthenticatedUser,
    connId: string,
    from: string | undefined,
  ): void {
    let shell: InteractiveShell | null = null;
    let rows = 24;
    let cols = 80;
    let stdinHandle: ResourceHandleIf | null = null;
    let pty = false;

    session.on('pty', (accept, _reject, info) => {
      pty = true;
      rows = info.rows;
      cols = info.cols;
      accept?.();
    });

    session.on('window-change', (accept, _reject, info) => {
      rows = info.rows;
      cols = info.cols;
      if (shell) {
        shell.resize(rows, cols);
      }
      accept?.();
    });

    session.on('shell', async (accept, _reject) => {
      const channel = accept();
      if (!channel) return;

      let sessionPath = '';

      try {
        sessionPath = await this.createSession(user);

        shell = new InteractiveShell({
          cem: this.config.cem,
          vfs: this.config.vfs,
          bufferManager: this.config.bufferManager,
          sessionPath,
          origin: 'ssh',
          from,
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
          rows,
          cols,
        });
        await shell.open();

        stdinHandle = await shell.openIOHandle('rawStdin', 'w');

        this.pipeReadableToHandle(channel.readable, stdinHandle);

        // The shell's stdout carries its stderr too, as a terminal's one output
        const output = this.pipeHandleToChannel(await shell.openIOHandle('stdout', 'r'), channel, { crlf: true });

        // Hang up running commands and tear down the shell when the interactive
        // session ends — whether by EOF or an abrupt client disconnect. Shell.close
        // is idempotent, so the channel 'close' backstop below is safe too. Closing
        // the shell ends its output, and the channel ends once the client has it all.
        shell.runInteractive().then(async () => {
          await shell?.close();
          await this.removeSession(sessionPath);
          await output;
          channel.exit(0);
          channel.end();
        }).catch(async (err) => {
          logger.error('shell error', { error: (err as Error).message });
          await shell?.close();
          await this.removeSession(sessionPath);
          await output;
          channel.exit(1);
          channel.end();
        });

        channel.on('close', () => {
          // Backstop for an abrupt disconnect. Shell.close is idempotent and the
          // unlink tolerates an already-removed node, so racing the path above
          // is harmless.
          shell?.close()
            .then(() => this.removeSession(sessionPath))
            .catch((err) => logger.error('shell close failed', { error: (err as Error).message }));
        });
      } catch (err) {
        logger.error('shell setup failed', {
          error: (err as Error).message,
        });
        // Setup can fail after the session node exists — nothing will ever
        // reach it, so it must not be left behind either.
        if (sessionPath) {
          await this.removeSession(sessionPath);
        }
        channel.exit(1);
        channel.end();
      }
    });

    session.on('exec', async (accept, _reject, info) => {
      const channel = accept();
      if (!channel) return;

      let sessionPath = '';
      // The whole exec round trip step by step; `LOG_MODULES=ssh-server:DEBUG`
      // (see Shell.open for the inside of its `open` step).
      const timer = new StepTimer();

      try {
        sessionPath = await this.createSession(user);
        timer.mark('session');

        const cmdShell = new Shell({
          cem: this.config.cem,
          vfs: this.config.vfs,
          bufferManager: this.config.bufferManager,
          sessionPath,
          origin: 'ssh-exec',
          from,
          // `ssh -t host cmd`: its ^C interrupts the command. Without a pty stdin is a pipe.
          terminal: pty,
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
        });
        await cmdShell.open();
        timer.mark('open');

        // Pipe channel stdin to shell stdin so exec commands can read input
        const stdinHandle = await cmdShell.openIOHandle('rawStdin', 'w');
        this.pipeReadableToHandle(channel.readable, stdinHandle);

        // Without a terminal the client keeps the two apart, as `ssh host cmd 2>/dev/null` relies on.
        const stderr = channel.stderr as StderrWritable;
        const stdout = await cmdShell.openIOHandle('stdout', 'r');
        const output = [
          this.pipeHandleToChannel(stdout, channel),
          this.pipeHandleToChannel(await cmdShell.openIOHandle('stderr', 'r'), stderr),
        ];
        timer.mark('pipes');

        // The client can write no more of what the command writes (`ssh host cmd | head`): its
        // next write fails as to a closed pipe, and the command ends with SIGPIPE.
        channel.on('eow', () => void this.config.bufferManager.closeRead(stdout.id));

        // A client that goes away hangs up what it ran, as an interactive session's does: the script
        // too, or a loop would start its next pass when the command running in it ends.
        const hangUp = new AbortController();
        channel.on('close', () => {
          hangUp.abort();
          cmdShell.close().catch((err) => logger.error('shell close failed', { error: (err as Error).message }));
        });

        const exitCode = await cmdShell.run(info.command, undefined, { signal: hangUp.signal });
        timer.mark('run');

        // Closing the shell ends its output buffers; what the command wrote is
        // still in them until the client's window has let it all out, and only
        // then do the exit status, EOF and close follow.
        await cmdShell.close();
        timer.mark('close');
        await Promise.all(output);
        timer.mark('drain');
        channel.exit(exitCode);
        channel.end();
        logger.debug('exec', { command: info.command, ...timer.report() });
      } catch (err) {
        logger.error('exec failed', {
          error: (err as Error).message,
          command: info.command,
        });
        void (channel.stderr as StderrWritable).write(`error: ${(err as Error).message}\n`);
        channel.exit(1);
        channel.end();
      } finally {
        if (sessionPath) {
          await this.removeSession(sessionPath);
        }
      }
    });

    session.on('sftp', (accept, _reject) => {
      const channel = accept();
      if (!channel) return;

      const sftp = new SFTP(
        { protocol: client.protocol },
        {
          type: 'session',
          incoming: channel.incoming,
          outgoing: channel.outgoing,
        },
        { server: true },
      );

      const handler = new SFTPHandler({
        vfs: this.config.vfs,
        access: { ...user.access, gids: [...user.access.gids] },
        homePath: homePath(user.username),
        from,
      });

      handler.attach(sftp);

      // The channel is read only while the handler takes more requests, so a client that
      // queues many waits for its window instead of having them all held here.
      this.pipeReadable(channel.readable, (data) => {
        sftp.push(data);
        return handler.ready();
      }, () => {
        // One-shot OpenSSH clients finish by sending CHANNEL_EOF, then wait
        // for the subsystem server to complete its half of the teardown.
        // Closing only the SFTP file handle does not close the SSH channel. The
        // subsystem ends cleanly, as OpenSSH's sftp-server does, with exit status 0:
        // without one, scp reports every transfer as failed.
        sftp.push(null);
        channel.exit(0);
        channel.end();
      });
      logger.info('SFTP session started', { connId, username: user.username });
    });
  }

  private async createSession(user: AuthenticatedUser): Promise<string> {
    const sessionName = `session-ssh-${ulid()}`;
    const sessionPath = join(this.config.env.SESSIONS_PATH, sessionName);

    await this.config.vfs.create<SessionAttrs>(
      ADMIN_ACCESS,
      'session',
      this.config.env.SESSIONS_PATH,
      sessionName,
      {
        props: { mode: 0o700 },
        attrs: {
          secret: ulid(),
          access: { ...user.access, gids: [...user.access.gids] },
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
          bootId: BOOT_ID,
        },
      },
    );

    return sessionPath;
  }

  /**
   * Drop the session node behind a finished channel.
   *
   * An SSH session is reachable only through its channel, so once the shell is
   * closed nothing can ever use it again, and a multiplexed client opens an
   * exec channel — and so a session — per command.
   *
   * Recursive because a shell that failed to close cleanly still has its tty
   * underneath; the stamp on both means `session-reap` would get them at the
   * next boot anyway, but there is no reason to wait for that.
   */
  private async removeSession(sessionPath: string): Promise<void> {
    try {
      await this.config.vfs.unlink(
        ADMIN_ACCESS,
        sessionPath,
        this.config.env.SESSIONS_PATH,
        { recursive: true, readlink: true },
      );
    } catch (err) {
      logger.debug('session cleanup failed', { sessionPath, error: (err as Error).message });
    }
  }

  /**
   * Send what is written to `handle` to the client until its end. Each write
   * waits for the client's window, so a command writing faster than the client
   * reads waits on its full buffer. Settles once everything is sent, or dropped
   * because the channel closed.
   */
  private async pipeHandleToChannel(
    handle: ResourceHandleIf,
    channel: Pick<Channel, 'write'>,
    opts?: { crlf?: boolean },
  ): Promise<void> {
    const reader = handle.readable.getReader();
    const crlf = opts?.crlf ?? false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await channel.write(crlf ? this.convertLfToCrlf(value) : value);
        }
      }
    } catch (_err) {
      // Handle closed
    } finally {
      reader.releaseLock();
      await handle.close();
    }
  }

  private pipeReadableToHandle(
    readable: ReadableStream<Uint8Array>,
    handle: ResourceHandleIf,
  ): void {
    const reader = readable.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await handle.write(value);
          }
        }
        // The client sent EOF: what reads the handle reads to its end, as `cat > file < photo.jpg` needs.
        await handle.writeEOF();
      } catch (_err) {
        // Stream closed
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private pipeReadable(
    readable: ReadableStream<Uint8Array>,
    onData: (data: Uint8Array) => void | Promise<void>,
    onEnd: () => void,
  ): void {
    const reader = readable.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await onData(value);
          }
        }
      } catch (_err) {
        // Stream closed
      } finally {
        reader.releaseLock();
        onEnd();
      }
    })();
  }

  /**
   * Convert lone LF (\n) to CRLF (\r\n) for SSH terminal output.
   * Preserves existing CRLF sequences.
   */
  private convertLfToCrlf(data: Uint8Array): Uint8Array {
    const LF = 0x0a;
    const CR = 0x0d;

    let extraBytes = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === LF && (i === 0 || data[i - 1] !== CR)) {
        extraBytes++;
      }
    }

    if (extraBytes === 0) {
      return data;
    }

    const result = new Uint8Array(data.length + extraBytes);
    let j = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === LF && (i === 0 || data[i - 1] !== CR)) {
        result[j++] = CR;
      }
      result[j++] = data[i];
    }

    return result;
  }
}

/** The account was deleted, or is disabled and may no longer act. */
function endsAccount(event: NodeEvent<UserAttrs>): boolean {
  return event.type === 'deleted' || event.node.attrs.inactive === true;
}
