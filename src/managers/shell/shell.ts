/**
 * A session's shell: bash, run by @ein/bash-executor, with its fds in the buffer manager, its
 * commands spawned through the execution manager and its state on a tty node.
 */

import {
  AstExecutor,
  BashSyntaxError,
  BROKEN_PIPE_STATUS,
  BrokenPipeError,
  type BuiltinRegistry,
  type CaptureBudgetIf,
  createBuiltinRegistry,
  type DirectoryEntry,
  type ExecCommandOptions,
  ExecContext,
  type ExecContextIf,
  type Job,
  type JobHostIf,
  type JobTable,
  type PathTestOperation,
  type PipeReadOptions,
  type TabCompletion,
  VOLATILE_PARAMS,
} from '@ein/bash-executor';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ETC_PATH, homePath, LOGS_PATH, MOD_PATH, TEMP_PATH, USERS_PATH } from '../../lib/paths.ts';
import { assert } from '@std/assert';
import { basename, dirname, isAbsolute, join, resolve } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ulid } from '@std/ulid';
import {
  type CaptureGuardErrorCode,
  type CmdFunction,
  type CmdState,
  type ExecutionManager,
  type RunAndCaptureOptions,
  type RunAndCaptureResult,
  type ShellJobInfo,
  TtyIf,
  TtyIO,
} from '../exec/mod.ts';
import { isTerminatingSignal, type Signal, signalExitCode } from '../exec/signal.ts';
import { deferred } from '../../lib/async/mod.ts';
import {
  Access,
  ADMIN_ACCESS,
  GUEST_ACCESS,
  GUEST_GID,
  GUEST_UID,
  GUEST_USERNAME,
  type HeldLink,
  isAdmin,
  isGuest,
  isVisitor,
  storedAccess,
  SUDO_GROUPNAME,
} from '../../lib/access/mod.ts';
import type { ShellOrigin } from '../../lib/api/system.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { guestMayBrowse } from '../../lib/config/mod.ts';
import { globToRegex, hasGlobChars } from '../../lib/glob/mod.ts';
import { getMimeFromExt } from '../../lib/media/mod.ts';
import { createLogger } from '../logger/mod.ts';
import { StepTimer } from '../../lib/metrics/mod.ts';
import type { BufferManagerIf } from '../buffer/mod.ts';
import { ResourceHandleIf, ResourceMode } from '../../registries/types.ts';
import { isMemberOf, userAccess } from '../../lib/auth/member-gids.ts';
import { AUTHENTICATION_FAILED, isAccountPassword, passwordSignIn } from '../../lib/auth/account-password.ts';
import { signInThrottle } from '../../lib/auth/sign-in-throttle.ts';
import { assertAccess, Node, NodeNotFoundError, NodePath, NodeVFS } from '../../vfs/mod.ts';
import { NODE_TYPE_COMMAND } from '../../vfs/types/command.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { NODE_TYPE_NULL } from '../../vfs/types/null.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';
import { FileAttrs, NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { isSessionNode, SessionAttrs } from '../../vfs/types/session.ts';
import { NODE_TYPE_TTY, TtyAttrs } from '../../vfs/types/tty.ts';
import { isUserNode, loginRefusal, UserAttrs } from '../../vfs/types/user.ts';
import { lookupCommandPath } from './command-lookup.ts';
import { InputMonitor, TerminalMode } from './input-monitor.ts';
import { color } from './terminal/mod.ts';
import { cachedTsCommand, loadTsCommand, moduleRootOf } from './ts-command-loader.ts';
import { commandVariables } from './variables.ts';

const logger = createLogger('tty');

// How long shell close waits for hung-up commands to unwind before tearing down buffers.
const SHELL_CLOSE_GRACE_MS = 250;
// How long the shell's HUP and EXIT traps get on close before they are stopped.
const SHELL_TRAP_GRACE_MS = 5_000;

// A background job (`cmd &`) as the host side of it: the executor keeps the job
// table, this is what it takes to run one here. Its output goes to private
// buffers which the shell forwards to the terminal while attached; on `disown`
// the terminal forwarder is swapped for a log forwarder and the buffers are
// transferred out of the shell so they survive close.
type ShellJob = {
  pid: string;
  /** The job table it went into, for the line that says it is done */
  table: JobTable;
  /** Waited for by `fg`, which says nothing when it ends */
  foreground: boolean;
  command: string;
  startedAt: number;
  outFd: string;
  errFd: string;
  outId: string;
  errId: string;
  forwarder: AbortController;
  logForwarder?: AbortController;
  logPumps?: Promise<void>[];
  detached: boolean;
  finished: boolean;
  exitCode?: number;
  done: Promise<number>;
};

/**
 * The background jobs the calling code runs inside, innermost last. The executor opens a pipe
 * without saying for whom, so this is how an fd learns which job it belongs to.
 */
const jobScope = new AsyncLocalStorage<readonly ShellJob[]>();

/** Set while the shell sources its own bashrc, which runs with the shell's access but is not what anyone typed. */
const shellSetup = new AsyncLocalStorage<true>();

const JOBS_LOG_BASE = `${LOGS_PATH}/jobs`;
const JOB_STATUS_FILE = 'status.json';

/**
 * `kill`'s signals, by bash's name, as a command here takes them. `STOP` is
 * the stop request a command can act on. `0`, and any signal not listed, only
 * finds out whether the process is there.
 */
const JOB_SIGNALS: Record<string, Signal | undefined> = {
  HUP: 'SIGHUP',
  INT: 'SIGINT',
  KILL: 'SIGKILL',
  PIPE: 'SIGPIPE',
  TERM: 'SIGTERM',
  TSTP: 'SIGTSTP',
  STOP: 'SIGTSTP',
  CONT: 'SIGCONT',
};

/**
 * What a detached job leaves behind next to its logs.
 *
 * A detached job outlives the shell that started it, and with the shell goes
 * the only place it was listed — the CEM drops a finished command's state after
 * a minute, so by the time anyone reconnects to ask, a sweep that ran for hours
 * looks exactly like one that never started. This is the durable half: it is
 * written when the job is detached and again when it exits, so `jobs
 * --detached` can answer both "is it still going" and "how did it end".
 *
 * `bootId` is what makes "still going" honest across a restart. A job cannot
 * survive the process, but its last written state can, so a record stamped with
 * an older boot is reported as abandoned rather than running.
 */
export type DetachedJobStatus = {
  pid: string;
  command: string;
  bootId: string;
  startedAt: number;
  state: 'running' | 'exited';
  exitCode?: number;
  exitedAt?: number;
};

/**
 * How stale `lastActivity` on a tty node is allowed to get.
 *
 * Nothing reads it today, so this exists only to keep the field honest enough to
 * be useful later without paying a write per command. Coarse on purpose: a shell
 * that runs a thousand commands in a minute writes twice, not a thousand times.
 */
const ACTIVITY_FLOOR_MS = 30_000;

/** A glob result as the pattern spelled it: `shown` is '' (relative start), '/', or a path. */
const joinShown = (shown: string, name: string): string => shown === '' ? name : shown.endsWith('/') ? `${shown}${name}` : `${shown}/${name}`;

export type ShellConfig = {
  cem: ExecutionManager;
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  rows?: number;
  cols?: number;
  sessionPath: NodePath;
  env?: Record<string, string>;
  onPwdChange?: (path: string) => void;
  /** Where the shell's input comes from; `system` when not given. */
  origin?: ShellOrigin;
  /** The address of the client on the other end, when there is one. */
  from?: string;
};

/** No command by that name: the status is 127, as bash's. */
class CommandNotFoundError extends Error {}

class CaptureGuardError extends Error {
  constructor(readonly code: CaptureGuardErrorCode, message: string) {
    super(message);
    this.name = 'CaptureGuardError';
  }
}

/**
 * An open fd: the handle the shell writes through, the id of the buffer behind it, and the
 * background jobs, innermost last, whose run opened it.
 */
type ShellFdEntry = { handle: ResourceHandleIf; id: string; jobs?: readonly ShellJob[] };

/**
 * Every shell of this process that can still run something: from `open` until
 * it is closed and no detached job of its is left, because a detached job's
 * steps run under the shell's access after the shell has closed. See
 * `signOutShellsOf` and `openShellList`.
 */
const liveShells = new Set<Shell>();

/** An open shell, as `who` reports it. */
type OpenShellInfo = {
  name: string;
  origin: ShellOrigin;
  /** The address of the client on the other end. */
  from?: string;
  access: Access;
  /** When the shell opened, and when input or a command last reached it. */
  openedAt: number;
  activeAt: number;
  cwd: string;
};

/** Every open shell of this process, oldest first. */
export function openShellList(): OpenShellInfo[] {
  return [...liveShells].filter((shell) => !shell.isClosed).map((shell) => shell.info()).sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Sign every shell acting as `uid` out to the guest, as `logout` does, and kill
 * its jobs, detached ones included, when the account is disabled. A shell takes
 * its access when it opens or logs in and keeps it; nothing else would take it
 * back. That reaches a closed shell whose detached job is still running too,
 * since the job's steps would go on starting under the shell's access.
 * Returns how many shells it reached.
 */
export async function signOutShellsOf(uid: number): Promise<number> {
  let reached = 0;
  for (const shell of liveShells) {
    if (shell.getAccess().uid !== uid) continue;
    try {
      await shell.logout();
      await shell.killJobs();
      reached++;
    } catch (error) {
      logger.warn('signing a shell out failed', { tty: shell.name, error: (error as Error).message });
    }
  }
  return reached;
}

/**
 * Change the share link `id` in every open shell acting as it: `replacement`, a changed expiry, in
 * its place, or, when the link is turned off, back to the guest. A shell keeps the access it opened
 * with, so the session nodes alone would not reach them.
 */
export async function updateHeldLinks(id: string, replacement?: HeldLink): Promise<void> {
  for (const shell of liveShells) {
    if (shell.getAccess().link?.id !== id) continue;
    if (replacement) shell.replaceHeldLink(replacement);
    else await shell.logout().catch((error) => logger.warn('ending a link in a shell failed', { tty: shell.name, error: (error as Error).message }));
  }
}

/**
 * Take back the elevation (`user-elevate`) of every shell acting as `uid`, when the account
 * leaves the `sudo` group. A shell keeps the access it has, so the session nodes alone would not
 * reach it. Returns how many shells it reached.
 */
export async function unelevateShellsOf(uid: number): Promise<number> {
  let reached = 0;
  for (const shell of liveShells) {
    const access = shell.getAccess();
    if (access.uid !== uid || access.elevated !== true) continue;
    try {
      await shell.markElevated(false);
      reached++;
    } catch (error) {
      logger.warn('taking back an elevation failed', { tty: shell.name, error: (error as Error).message });
    }
  }
  return reached;
}

export class Shell implements TtyIf {
  readonly name = `tty-${ulid()}`;
  readonly origin: ShellOrigin;
  readonly launchEnv: Readonly<Record<string, string>>;
  /** The address of the client on the other end; a retained terminal's moves with whoever attaches. */
  from?: string;
  private openedAt = 0;
  private activeAt = 0;
  protected rows: number;
  protected cols: number;
  protected ctx: ExecContextIf;
  protected access?: Access;
  protected io: TtyIO;
  private executor: AstExecutor;
  private fdMap: Map<string, ShellFdEntry | null> = new Map(); // FD number → FileHandle + buffer ID
  // The fds a detached job took with it. They stay in `fdMap` — the job is still
  // running, and a job that is a whole compound command goes on to start
  // commands of its own, each of which has to be able to name and write the
  // buffer its output goes to. What they are exempt from is teardown: closing
  // the shell must neither close their handles nor delete their buffers, or the
  // sweep that was detached to survive the session dies with it anyway. `reapJob`
  // does that teardown instead, when the job itself is over.
  private detachedFds: Set<string> = new Set();
  private fdReadBuffers: Map<string, string> = new Map();
  protected decoder = new TextDecoder();
  protected encoder = new TextEncoder();
  private lastPwd: string = '';
  private inputMonitor?: InputMonitor;
  private rawStdinId?: string; // io-0-raw buffer ID for shell-handler to write to
  private closed = false;
  /** The running jobs by pid; the job table itself is the executor's */
  private hostJobs = new Map<string, ShellJob>();
  /** Finished jobs waiting for a prompt to be announced before — see `reportJob`. */
  private jobReports: { table: JobTable; job: Job }[] = [];
  /** Set when `exit` ended the shell, rather than its terminal going away */
  private exited = false;
  /** Fingerprint of the state last written to the tty node — see `persist`. */
  private persistedState?: string;
  private persistedAt = 0;

  constructor(protected config: ShellConfig) {
    this.origin = config.origin ?? 'system';
    this.launchEnv = config.env ?? {};
    this.from = config.from;
    this.rows = config.rows || 24;
    this.cols = config.cols || 80;
    this.executor = new AstExecutor(this, {
      builtins: this.guardBuiltins(createBuiltinRegistry()),
    });
    this.ctx = new ExecContext();
    // `$$`, and `$BASHPID` with it, is the shell's own name: EiN has no process
    // numbers, and a job's pid is `bg-…` the same way. It is unique, as a
    // script that names a temporary file after it needs.
    this.ctx.setParams({ '$': this.name });

    // Job control is on in every EiN shell, interactive or not. bash has it
    // off in a non-interactive one, where `fg` answers "no job control in this
    // shell"; scripts here use `fg`, so the deviation is the default, and
    // `set +m` still turns it off.
    this.ctx.setShellOption('monitor', true);
    // Aliases likewise: bash expands them only in an interactive shell or under
    // `shopt -s expand_aliases`; every EiN shell expands them
    this.ctx.setShellOption('expand_aliases', true);
    // And `**` goes down every level of the tree: `ls **/*.jpg`
    this.ctx.setShellOption('globstar', true);
    this.io = {
      stdin: `${this.name}/io-0`,
      stdout: `${this.name}/io-1`,
      stderr: `${this.name}/io-2`,
    };

    config.env && this.ctx.setEnv({
      ...config.env,
      TTY_NAME: this.name,
    });
  }

  /** True once close() has torn down the fds — nothing may read or write after this. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** True once `exit` has ended the shell; whoever runs it closes it then. */
  get hasExited(): boolean {
    return this.exited;
  }

  /** True if the fd exists and is fully open (a reserved-but-null entry does not count). */
  hasPipe(fd: string): boolean {
    return Boolean(this.fdMap.get(fd));
  }

  private async persist(): Promise<void> {
    // close() unlinks the tty node; a run()/runAndCapture() finishing its finally
    // after that would hit NodeNotFound. Nothing to persist once closed.
    if (this.closed) {
      return;
    }

    // Runs in the `finally` of every run()/runAndCapture(), and each write is a
    // transaction plus an event fanout. Nothing reads a tty node's attrs back,
    // so a write that would only bump `lastActivity` is skipped: the node is
    // written when the state changes, and otherwise at most once per
    // ACTIVITY_FLOOR_MS.
    const env = this.ctx.getEnv();
    const params = this.persistedParams();
    const cwd = this.ctx.getCwd();
    const state = this.fingerprint();
    const now = Date.now();

    if (state === this.persistedState && now - this.persistedAt < ACTIVITY_FLOOR_MS) {
      // cwd is part of the fingerprint, so an unchanged fingerprint also means
      // there is no pwd change to report.
      return;
    }

    this.persistedState = state;
    this.persistedAt = now;

    await this.config.vfs.update<TtyAttrs>(
      ADMIN_ACCESS,
      join(this.config.sessionPath, this.name),
      {
        props: {
          uid: this.access!.uid,
          gid: this.access!.gid,
        },
        attrs: {
          lastActivity: now,
          access: this.access,
          env,
          params,
          cwd,
          rows: this.rows,
          cols: this.cols,
        },
      },
    );

    if (this.config.onPwdChange && cwd !== this.lastPwd) {
      this.lastPwd = cwd;
      this.config.onPwdChange(cwd);
    }
  }

  /**
   * The parameters `persist()` writes: all but those that change with every
   * command on their own — `$?`, `$LINENO`, `$BASH_COMMAND`, `$SECONDS`,
   * `$RANDOM` and the rest. Nothing reads them back from the node, and
   * counting them would make nearly every command a state change worth a
   * transaction.
   */
  private persistedParams(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.ctx.getParams()).filter(([name]) => !VOLATILE_PARAMS.has(name)));
  }

  /** The state `persist()` writes, as one comparable string. */
  private fingerprint(): string {
    return JSON.stringify([this.access, this.ctx.getEnv(), this.persistedParams(), this.ctx.getCwd(), this.rows, this.cols]);
  }

  getIO(): TtyIO {
    return this.io;
  }

  getEnv() {
    return this.ctx.getEnv();
  }

  getAccess(): Access {
    return { ...this.access! };
  }

  /**
   * Whether this is the guest's shell where visitors are asked to sign in (`CFG_GUEST_BROWSING`
   * off). It then runs the commands signing in takes (`CmdSpec.guest`) and nothing else: no
   * builtin, no other command, and nothing of the shell's own reaches the VFS — no redirection
   * to or from a file, pathname expansion, file test or `$(< file)`. Its own bashrc still runs.
   */
  async refusesGuest(): Promise<boolean> {
    return isGuest(this.access!) && !shellSetup.getStore() && !await guestMayBrowse(this.config.vfs);
  }

  /** Throw where `refusesGuest`, for the host's ways into the VFS. */
  private async assertNotRefusedGuest(): Promise<void> {
    if (await this.refusesGuest()) throw new Error('sign in first');
  }

  /** `registry` with every builtin refusing the guest where `refusesGuest`. */
  private guardBuiltins(registry: BuiltinRegistry): BuiltinRegistry {
    for (const [name, handler] of registry) {
      registry.set(name, async (ctx, ...rest) => await this.refusesGuest() ? { code: 126, stderr: `${name}: sign in first\n` } : await handler(ctx, ...rest));
    }
    return registry;
  }

  /**
   * The access a command or redirection in `ctx` writes with: the shell's, carrying the run a
   * script was attributed to when `runAndCapture` was given one.
   */
  private accessIn(ctx: ExecContextIf): Access {
    const attribution = ctx.getHostData() as RunAndCaptureOptions['attribution'];
    return attribution ? { ...this.access!, ...attribution } : this.access!;
  }

  info(): OpenShellInfo {
    return {
      name: this.name,
      origin: this.origin,
      from: this.from,
      access: this.getAccess(),
      openedAt: this.openedAt,
      activeAt: this.activeAt,
      cwd: this.ctx.getCwd(),
    };
  }

  async open(): Promise<void> {
    this.openedAt = this.activeAt = Date.now();
    // Every step below is a sequential round trip, and under load the sum is
    // the first command's latency; the breakdown goes to the debug log so a
    // slow session can be read step by step (`LOG_MODULES=tty:DEBUG`).
    const timer = new StepTimer();

    const sessionNode = await this.config.vfs.get<SessionAttrs>(
      ADMIN_ACCESS,
      this.config.sessionPath,
    );
    timer.mark('session');

    // The terminal is this one, whatever the session's environment says: it
    // was copied from whoever made the session.
    this.ctx.setEnv({ ...sessionNode.attrs.env, TTY_NAME: this.name });

    this.access = isSessionNode(sessionNode) ? storedAccess(sessionNode.attrs.access) : GUEST_ACCESS;

    this.ctx.setEnv({
      HOME: '/',
      PWD: '/',
      OLDPWD: '/',
      UID: this.access.uid.toString(),
      GID: String(this.access.gid ?? ''),
      SID: this.access.sid?.toString() || '',
    });

    try {
      assert(this.ctx.getEnv().USERS_PATH, 'USER_PATH environment variable must be set');

      const users = await this.config.vfs.children<UserAttrs>(
        ADMIN_ACCESS,
        this.ctx.getEnv().USERS_PATH,
      );
      const userEntry = users.find((entry) => isUserNode(entry.node) && entry.node.attrs.uid === this.access!.uid);
      // A share link's principal has no account: it goes by the guest's name and home.
      const username = this.access.link ? GUEST_USERNAME : userEntry?.name || this.access.uid.toString();
      const home = homePath(username);
      this.ctx.setEnv({
        USER: username,
        HOME: home,
        PWD: home,
      });
      this.ctx.setCwd(this.ctx.getEnv().PWD);
    } catch {
      // Pass
    }
    timer.mark('user');

    // io-0-raw is the terminal's input, which the InputMonitor reads; io-0 is
    // what it passes on, which commands read.
    const br = this.config.bufferManager;
    this.rawStdinId = `${this.name}/io-0-raw`;
    await br.touch(this.rawStdinId, {});
    await br.touch(this.io.stdin, {});
    await br.touch(this.io.stdout, {});
    await br.touch(this.io.stderr, {});

    const rawStdinHandle = await br.open(this.rawStdinId, {}, 'r+');
    const filteredStdinHandle = await br.open(this.io.stdin, {}, 'w');
    this.fdMap.set('0', {
      handle: await br.open(this.io.stdin, {}, 'r'),
      id: this.io.stdin,
    });
    this.fdMap.set('1', {
      handle: await br.open(this.io.stdout, {}, 'w'),
      id: this.io.stdout,
    });
    this.fdMap.set('2', {
      handle: await br.open(this.io.stderr, {}, 'w'),
      id: this.io.stderr,
    });

    this.inputMonitor = new InputMonitor({
      rawStdin: rawStdinHandle,
      filteredStdin: filteredStdinHandle,
      onInput: () => {
        this.activeAt = Date.now();
      },
      onSignal: (signal) => {
        if (signal === 'interrupt') {
          this.config.cem.interrupt(this.name);
        }
        // EOF is handled by the read loop ending
      },
    });
    await this.inputMonitor.start();
    timer.mark('buffers');

    // Before the tty node: /etc/bashrc rewrites most of the environment, so
    // the node is created once with it rather than created and then updated.
    // Nothing bashrc runs needs the node, only the buffers above. The create
    // primes the persist fingerprint so the first command does not repeat it.
    await this.sourceBashrc(timer);

    const now = Date.now();
    await this.config.vfs.create<TtyAttrs>(
      ADMIN_ACCESS,
      NODE_TYPE_TTY,
      this.config.sessionPath,
      this.name,
      {
        props: {
          uid: this.access.uid,
          gid: this.access.gid,
        },
        attrs: {
          createdAt: now,
          lastActivity: now,
          bootId: BOOT_ID,
          access: this.access,
          env: this.ctx.getEnv(),
          params: this.ctx.getParams(),
          cwd: this.ctx.getCwd(),
          rows: this.rows,
          cols: this.cols,
        },
      },
    );
    this.persistedState = this.fingerprint();
    this.persistedAt = now;
    timer.mark('tty');

    logger.debug('open', { tty: this.name, ...timer.report() });
    liveShells.add(this);
  }

  /**
   * Source /etc/bashrc, which in turn sources the two configuration layers.
   *
   * Called again after `login`, because the user layer it reaches is
   * `$HOME/.config` and `HOME` only becomes the right one once we know who is
   * signed in. Without the second pass a personal setting would apply to an SSH
   * session (whose shell is constructed after authentication) but not to the
   * web UI, whose shell opens as guest on connect and logs in afterwards.
   */
  private async sourceBashrc(timer?: StepTimer): Promise<void> {
    const rcFile = join(this.getEnv().ETC_PATH || ETC_PATH, 'bashrc');
    try {
      const exists = await this.config.vfs.exists(this.access!, rcFile);
      timer?.mark('bashrc-exists');
      if (!exists) {
        return;
      }
      // Not `run()`: that persists the tty afterwards, and here the caller
      // decides when the tty is written — `open()` creates the node with the
      // sourced environment already in it, `login` persists once at its end.
      try {
        await shellSetup.run(true, () => this.executor.execute(`source "${rcFile}"`, this.ctx));
      } catch (err) {
        await this.pipeWrite('2', `Error: ${(err as Error).message}\n`);
      }
      timer?.mark('bashrc-source');
    } catch {
      // Do nothing
    }
  }

  /**
   * The shell's own end, as bash has it: the HUP trap when its terminal went
   * away rather than `exit` ending it, then the EXIT trap. They run before the
   * shell's commands are hung up, so that a trap can still reach its jobs.
   */
  private async runEndTraps(): Promise<void> {
    const ctx = this.ctx.spawnContext();

    ctx.setAbortSignal(AbortSignal.timeout(SHELL_TRAP_GRACE_MS));

    try {
      if (!this.exited) {
        await this.executor.trapSignal(ctx, 'HUP');
      }

      await this.executor.runExitTrap(ctx, Number(ctx.getParams()['?'] ?? 0));
    } catch (error) {
      logger.warn('shell end traps failed', { error: (error as Error).message });
    }
  }

  async close(): Promise<void> {
    // Idempotent: a shell can be closed from several locations (WS handler, SSH
    // channel end, service stop), and its buffers are torn down once.
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.hasLiveDetachedJob()) {
      liveShells.delete(this);
    }

    await this.runEndTraps();

    // What to tear down is decided now, before anything is awaited: the fds the
    // shell has at this moment, minus the two a detached job logs through and
    // the ones a detached job opened itself — its redirections, one pipe per
    // `$( )`, one per pipeline stage. Those must not be swept up with the
    // shell's: closing a redirection's pipe fails the job's next write with
    // "pipe is closed", deleting a pipeline pipe under a running stage leaves
    // its reader at EOF with half the output, or hung, and the substitution's
    // `pipeClose` fails with "no pipe for FD". The job removes them itself, as
    // whoever opened an fd during the grace below does. The entry, not just the
    // fd number, is remembered: an fd freed during the grace is reused by the
    // next `pipeOpen`, so a number alone would name someone else's new pipe.
    const snapshot = [...this.fdMap].filter(([fd, entry]) => entry && !this.detachedFds.has(fd) && !entry.jobs?.some((job) => job.detached)) as [string, ShellFdEntry][];

    // Hang up any commands still running in this shell so they stop instead of
    // being orphaned writing to buffers we are about to delete. Detached jobs
    // (disown/nohup) are skipped and survive.
    try {
      await this.config.cem.signal(this.name, 'SIGHUP', { includeBackground: true, skipDetached: true });
      // Brief grace so signalled commands can unwind and dispose their handles
      // before the buffers vanish underneath them.
      await this.config.cem.waitForTty(this.name, SHELL_CLOSE_GRACE_MS);
    } catch (error) {
      logger.warn('failed to hang up commands on shell close', { error: (error as Error).message });
    }

    this.inputMonitor?.stop();

    // Close all handles, except the ones a detached job is still writing to —
    // those belong to the job now, and `reapJob` ends them when it finishes.
    // An fd whose entry changed during the grace was closed by its owner and
    // reopened by someone else since; it is theirs, not ours.
    const owned = snapshot.filter(([fd, entry]) => this.fdMap.get(fd) === entry);
    await Promise.all(owned.map(([, entry]) => entry.handle.close().catch(() => {})));
    for (const [fd] of owned) {
      this.fdReadBuffers.delete(fd);
    }

    const br = this.config.bufferManager;
    const bufferIds = owned.map(([, entry]) => entry.id);
    if (this.rawStdinId) bufferIds.push(this.rawStdinId);
    await Promise.all([...new Set(bufferIds)].map((id) => br.delete(id)));
    for (const [fd] of owned) {
      this.fdMap.delete(fd);
    }

    const shellPath = join(this.config.sessionPath, this.name);
    try {
      await this.config.vfs.unlink(
        ADMIN_ACCESS,
        shellPath,
        this.config.sessionPath,
        { recursive: true, readlink: true },
      );
    } catch (error) {
      // A session reaper or another close path may already have removed it.
      if (!(error instanceof NodeNotFoundError)) {
        throw error;
      }
    }
  }

  /** The buffer the terminal's input is written to. */
  getRawStdinId(): string {
    if (!this.rawStdinId) {
      throw new Error('shell not opened yet');
    }
    return this.rawStdinId;
  }

  /** Open a handle to an I/O buffer (stdout, stderr, or rawStdin). */
  async openIOHandle(which: 'stdout' | 'stderr' | 'rawStdin', mode: ResourceMode): Promise<ResourceHandleIf> {
    const br = this.config.bufferManager;
    switch (which) {
      case 'stdout':
        return await br.open(this.io.stdout, {}, mode);
      case 'stderr':
        return await br.open(this.io.stderr, {}, mode);
      case 'rawStdin':
        return await br.open(this.getRawStdinId(), {}, mode);
    }
  }

  /** Raw while a line is read at the prompt, cooked while a command runs. */
  setTerminalMode(mode: TerminalMode): void {
    this.inputMonitor?.setMode(mode);
  }

  async resize(rows: number, cols: number): Promise<void> {
    try {
      this.rows = rows;
      this.cols = cols;
      await this.persist();
      await this.config.cem.resize(this.name, rows, cols);
    } catch (error) {
      logger.error('Failed to set resize on shell, maybe it should be removed', error);
    }
  }

  /**
   * Execute a bash script.
   *
   * `opts.signal` hangs the whole script up: the executor checks it between
   * nodes, and `waitForCommand` passes it on to the command running at that
   * moment as a SIGTERM. A loop script otherwise survives a signal to its
   * running command and starts the next pass. The script then runs in a
   * subcontext, as `runAndCapture` does, so the signal does not stay on the
   * shell's own context after the script is gone.
   */
  async run(script: string, ctx?: ExecContextIf, opts: { signal?: AbortSignal; history?: boolean } = {}): Promise<number> {
    // A closed shell has no fds: executing would bridge the inherited stdin '0'
    // (no longer in fdMap) as a file and read `<cwd>/0`. A stale caller (e.g.
    // an orphaned pipeline engine) fails fast instead.
    //
    // A live detached job is the one caller that is not stale: it was built to
    // outlive this shell, its fds are still in `fdMap` (close() exempts them),
    // and a detached compound command reaches here every time it runs a step.
    // See ein/core#211.
    if (this.closed && !this.hasLiveDetachedJob()) {
      throw new Error('shell is closed');
    }
    // A command running a script passes its own context, and is not someone at the shell.
    if (!ctx) this.activeAt = Date.now();
    let runCtx = ctx || this.ctx;
    if (opts.signal) {
      runCtx = runCtx.subContext();
      runCtx.setAbortSignal(opts.signal);
    }
    const exited = { value: false };

    try {
      // Typed at the prompt: read a line at a time, history-expanded and kept in the history as bash does
      return await this.executor.execute(script, runCtx, { exited, history: opts.history });
    } catch (err) {
      // The abort is how the hangup reached the executor, so the throw it
      // raises is the intended stop, not a failure to report.
      if (opts.signal?.aborted) {
        return 130;
      }
      console.error('run', err);
      await this.pipeWrite('2', `Error: ${(err as Error).message}\n`);
      return 1;
    } finally {
      // `exit` ends the shell when the script ran in the shell itself, not in a
      // command's context: a command that runs a script does not end it
      if (exited.value && !ctx) {
        this.exited = true;
      }
      await this.persist().catch((error) => logger.error('failed to persist', { error }));
    }
  }

  /**
   * What a Tab at `point` in `line` does, as bash's readline does it: the
   * line it leaves, and the matches to list when `list` (the Tab after one
   * that changed nothing).
   */
  protected async completeTab(line: string, point: number, list: boolean): Promise<TabCompletion> {
    return await this.executor.completeTab(this.ctx, line, point, list);
  }

  /** Whether `text` stops inside a command, so the prompt should ask for another line. */
  protected async isUnfinished(text: string): Promise<boolean> {
    return await this.executor.isUnfinished(text, this.ctx);
  }

  /**
   * The history as an interactive bash starts it: HISTFILE, `~/.bash_history`
   * unless set, cut to HISTFILESIZE and read. The executor reads and writes it.
   */
  protected async startHistory(): Promise<void> {
    await this.executor.startHistory(this.ctx);
  }

  /** `history -a`: what was added since, to the end of HISTFILE. */
  protected async appendHistory(): Promise<void> {
    await this.executor.appendHistory(this.ctx);
  }

  /** The history saved as a shell that ends saves it. */
  protected async saveHistory(): Promise<void> {
    await this.executor.saveHistory(this.ctx);
  }

  /** Execute a bash script and return its exit code and captured output. */
  async runAndCapture(
    script: string,
    ctx: ExecContextIf = this.ctx,
    opts: RunAndCaptureOptions = {},
  ): Promise<RunAndCaptureResult> {
    // See run(): refuse once closed so stale callers fail fast rather than
    // bridging stdin '0' as a file and doing zombie work on a dead shell — but
    // not while a detached job this shell still owns is running, which is the
    // path every `cmd.execute()` inside a detached sweep takes.
    if (this.closed && !this.hasLiveDetachedJob()) {
      throw new Error('shell is closed');
    }
    // A request on the shell's own context is someone using it; `cmd.execute` passes a command's.
    if (ctx === this.ctx) this.activeAt = Date.now();
    if (opts.env || opts.attribution) {
      // A subshell of the caller's context, so the variables and the attribution reach the
      // script and nothing else.
      ctx = ctx.subContext();
      if (opts.env) ctx.setLocalEnv(opts.env);
      if (opts.attribution) ctx.setHostData(opts.attribution);
    }
    const controller = new AbortController();
    let capturedBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const abort = (error: CaptureGuardError) => {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    };

    // The budget is the drain's per-chunk hook, so it also carries `onOutput`.
    const captureBudget: CaptureBudgetIf | undefined = opts.maxOutputBytes === undefined && !opts.onOutput ? undefined : {
      consume: (bytes) => {
        opts.onOutput?.();
        if (opts.maxOutputBytes === undefined) return;
        capturedBytes += bytes;
        if (capturedBytes > opts.maxOutputBytes!) {
          abort(
            new CaptureGuardError(
              'OUTPUT_LIMIT_EXCEEDED',
              `api shell command exceeded ${opts.maxOutputBytes}-byte output limit`,
            ),
          );
          throw controller.signal.reason;
        }
      },
    };

    if (opts.timeoutMs !== undefined) {
      timeout = setTimeout(() =>
        abort(
          new CaptureGuardError(
            'EXEC_TIMEOUT',
            `api shell command timed out after ${opts.timeoutMs} ms`,
          ),
        ), opts.timeoutMs);
    }

    const hangUp = () => {
      if (!controller.signal.aborted) controller.abort(opts.signal!.reason);
    };
    if (opts.signal?.aborted) hangUp();
    else opts.signal?.addEventListener('abort', hangUp, { once: true });

    try {
      const result = await this.executor.executeAndCapture(script, ctx, {
        signal: controller.signal,
        captureBudget,
      });

      if (controller.signal.reason instanceof CaptureGuardError) {
        // The executor already appended its own `Error:` line for the abort; the
        // guard's message replaces that line, after whatever the command managed
        // to write — for a timed-out command that output is the only clue to
        // where it stalled.
        // Not for the output cap, though: handing back the very output that
        // tripped it is what the cap exists to prevent.
        const keep = controller.signal.reason.code === 'EXEC_TIMEOUT';
        const written = keep ? result.stderr.replace(/Error: [^\n]*\n?$/, '') : '';
        return {
          code: 1,
          stdout: keep ? result.stdout : '',
          stderr: `${written}${controller.signal.reason.message}`,
          errorCode: controller.signal.reason.code,
        };
      }

      return result;
    } catch (err) {
      console.error('runAndCapture', err);
      return { code: 1, stdout: '', stderr: `Error: ${(err as Error).message}\n` };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', hangUp);
      await this.persist();
    }
  }

  /**
   * Sign this shell in as the account `typed` names, by username or e-mail address, with its
   * password (`passwordSignIn`), from the fixed layout and `launchEnv` rather than this shell's
   * environment, which whoever is at the shell can change; `session` also makes the sign-in the session's.
   */
  async login(
    typed: string,
    password: string,
    session?: boolean,
  ): Promise<void> {
    const { username, userNode } = await passwordSignIn(this.config.vfs, typed, password, { env: this.launchEnv, from: this.from });

    // Signing in from a share link becomes the account: the link opens nothing for someone signed in.
    this.access = await userAccess(this.config.vfs, ADMIN_ACCESS, username, userNode);

    this.ctx.setEnv({
      USER: username,
      HOME: homePath(username),
      UID: this.access.uid.toString(),
      GID: String(this.access.gid ?? ''),
      SID: this.access.sid?.toString() || '',
    });

    // HOME now names the person who just signed in, so their $HOME/.config has
    // somewhere to be read from.
    await this.sourceBashrc();

    await this.persist();

    if (session) {
      const sessionNode = await this.config.vfs.get<SessionAttrs>(
        ADMIN_ACCESS,
        this.config.sessionPath,
      );
      await this.config.vfs.update<SessionAttrs>(
        ADMIN_ACCESS,
        this.config.sessionPath,
        {
          attrs: {
            lastActivity: Date.now(),
            access: this.access,
            env: {
              ...(sessionNode.attrs.env || {}),
              USER: username,
              HOME: homePath(username),
              UID: this.access.uid.toString(),
              GID: String(this.access.gid ?? ''),
              SID: this.access.sid?.toString() || '',
            },
          },
        },
      );
    }
  }

  /**
   * Act as a share link's principal (`access`): this shell — and with `session`, every connection
   * of its session from then on — reads what the link opens and nothing an earlier link did, and
   * opening the same one again takes up a changed expiry.
   */
  async actAsLink(access: Access, session?: boolean): Promise<void> {
    this.access = access;
    this.ctx.setEnv({ UID: access.uid.toString(), GID: String(access.gid) });
    await this.persist();

    if (session) {
      await this.config.vfs.update<SessionAttrs>(ADMIN_ACCESS, this.config.sessionPath, {
        attrs: { lastActivity: Date.now(), access: this.access },
      });
    }
  }

  /** Put `replacement` — the same link with a changed expiry — in place of the one this shell acts as. */
  replaceHeldLink(replacement: HeldLink): void {
    if (this.access?.link?.id === replacement.id) this.access = { ...this.access, link: replacement };
  }

  /** The account whose uid is `uid`: its name and user node, from the fixed layout as `login` reads it. */
  private async accountOf(uid: number): Promise<{ name: string; node: Node<UserAttrs> } | undefined> {
    const users = await this.config.vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH);
    const entry = users.find((each) => isUserNode(each.node) && each.node.attrs.uid === uid);
    return entry && { name: entry.name, node: entry.node };
  }

  /**
   * Make this shell's sign-in an administrator's (`user-elevate`), and with `session` its
   * session's too, with every shell of the session, so the pages and terminals it opens from then
   * on are elevated as well. The account must still be allowed to sign in and be in the `sudo`
   * group now — not as it was when it signed in — and `password` must be its own, tried no faster
   * than `signInThrottle` lets a sign-in be.
   */
  async elevate(password: string, session?: boolean): Promise<void> {
    const access = this.access!;
    if (isVisitor(access)) throw new Error('sign in first');
    if (isAdmin(access) && access.elevated !== true) throw new Error('already an administrator');
    const account = await this.accountOf(access.uid);
    if (!account) throw new Error(AUTHENTICATION_FAILED);
    const refusal = loginRefusal(account.node.attrs);
    if (refusal) throw new Error(refusal);
    if (!await isMemberOf(this.config.vfs, ADMIN_ACCESS, SUDO_GROUPNAME, account.name, account.node)) {
      throw new Error(`${account.name} is not in the ${SUDO_GROUPNAME} group`);
    }
    const attempt = await signInThrottle.begin(account.name, this.from);
    if (!await isAccountPassword(this.config.vfs, join(USERS_PATH, account.name), password)) throw new Error(AUTHENTICATION_FAILED);
    attempt.succeeded();
    await this.setElevated(true, session);
    logger.info('sign-in elevated', { tty: this.name, uid: access.uid, session: session === true });
  }

  /** Make this shell's sign-in, and with `session` its session's and every shell of it, no longer an administrator's. */
  async unelevate(session?: boolean): Promise<void> {
    await this.setElevated(false, session);
  }

  /**
   * Set or clear `elevated` on this shell's access and, with `session`, on its session's and every
   * other shell of the session acting as the same account. The session must be signed in as that
   * account: elevating it is no way to sign it in.
   */
  private async setElevated(on: boolean, session?: boolean): Promise<void> {
    const { uid } = this.access!;
    const shells = new Set<Shell>([this]);
    if (session) {
      const sessionNode = await this.config.vfs.get<SessionAttrs>(ADMIN_ACCESS, this.config.sessionPath);
      if (!isSessionNode(sessionNode) || sessionNode.attrs.access?.uid !== uid) {
        throw new Error('the session is not signed in as this account');
      }
      const { elevated: _, ...access } = sessionNode.attrs.access;
      await this.config.vfs.update<SessionAttrs>(ADMIN_ACCESS, this.config.sessionPath, {
        attrs: { lastActivity: Date.now(), access: on ? { ...access, elevated: true } : access },
      });
      for (const shell of liveShells) {
        if (shell.config.sessionPath === this.config.sessionPath && shell.access?.uid === uid) shells.add(shell);
      }
    }
    for (const shell of shells) await shell.markElevated(on);
  }

  /** Set or clear `elevated` on this shell's access alone. */
  async markElevated(on: boolean): Promise<void> {
    const { elevated: _, ...access } = this.access!;
    this.access = on ? { ...access, elevated: true } : access;
    await this.persist();
  }

  async logout(session?: boolean): Promise<void> {
    this.access = {
      uid: GUEST_UID,
      gid: GUEST_GID,
      gids: [GUEST_GID],
    };

    this.ctx.setEnv({
      USER: GUEST_USERNAME,
      UID: this.access.uid.toString(),
      GID: String(this.access.gid ?? ''),
      SID: this.access.sid?.toString() || '',
      HOME: homePath(GUEST_USERNAME),
    });

    await this.persist();

    if (session) {
      const sessionNode = await this.config.vfs.get<SessionAttrs>(
        ADMIN_ACCESS,
        this.config.sessionPath,
      );
      await this.config.vfs.update<SessionAttrs>(
        ADMIN_ACCESS,
        this.config.sessionPath,
        {
          attrs: {
            lastActivity: Date.now(),
            access: this.access,
            env: {
              ...(sessionNode.attrs.env || {}),
              USER: GUEST_USERNAME,
              HOME: homePath(GUEST_USERNAME),
              UID: this.access.uid.toString(),
              GID: String(this.access.gid ?? ''),
              SID: this.access.sid?.toString() || '',
            },
          },
        },
      );
    }
  }

  // ===== ShellIf Implementation =====

  async execute(
    ctx: ExecContextIf,
    name: string,
    args: string[],
    _opts: ExecCommandOptions,
  ): Promise<number> {
    try {
      return await this.execExternal(ctx, name, args);
    } catch (err) {
      // A hang-up reaches the command as an abort: an intended stop, not a failure to log.
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.error('execute error:', err);
      throw err;
    }
  }

  /**
   * Where `type`, `command -v` and `hash` find a command: the node PATH (or
   * `path`) leads its name to, or the node a path names. A core command has
   * its node in /bin, so it is found the same way.
   */
  async lookupCommand(ctx: ExecContextIf, name: string, path?: string): Promise<string[]> {
    if (name.includes('/')) {
      const full = resolve(ctx.getCwd(), name);

      return !await this.refusesGuest() && await this.config.vfs.exists(this.access!, full) ? [full] : [];
    }

    const found = await lookupCommandPath(this.config.vfs, path ?? ctx.getEnv().PATH ?? '', name);

    return found ? [found] : [];
  }

  /**
   * A node's children, for the executor's pathname expansion. Any node may have
   * children here, so one counts as a directory when it is one, has some, or is
   * a softlink, which `**` then does not go down into.
   */
  async readDirectory(ctx: ExecContextIf, path: string): Promise<DirectoryEntry[] | null> {
    try {
      await this.assertNotRefusedGuest();
      const children = await this.config.vfs.children(this.access!, resolve(ctx.getCwd(), path));

      return children.map((child) => {
        const link = child.node.type === NODE_TYPE_SOFTLINK;

        return { name: child.name, directory: child.node.type === NODE_TYPE_DIRECTORY || child.childCount > 0 || link, link };
      });
    } catch {
      return null;
    }
  }

  async resolvePath(_ctx: ExecContextIf, text: string): Promise<string[]> {
    if (!hasGlobChars(text)) {
      return [text];
    }

    await this.assertNotRefusedGuest();

    // Expand against the VFS, but answer in the form the pattern was written in: `b*` in /usr is
    // `bin`, `../b*` is `../bin`, as in bash.
    const absolute = isAbsolute(text);
    const segments = text.split('/').filter((s) => s !== '');

    return this.expandGlobSegments(absolute ? '/' : _ctx.getCwd(), absolute ? '/' : '', segments);
  }

  /** `path` is the node the segments so far lead to, `shown` the same path as the pattern spells it. */
  private async expandGlobSegments(path: string, shown: string, segments: string[]): Promise<string[]> {
    if (segments.length === 0) {
      return [shown];
    }

    const [segment, ...rest] = segments;

    if (segment === '**') {
      return this.expandRecursiveGlob(path, shown, rest);
    }

    if (hasGlobChars(segment)) {
      try {
        const children = await this.config.vfs.children(this.access!, path);

        const regex = globToRegex(segment);

        const matchedChildren = children.filter((child) => {
          // Hidden files match only a pattern that starts with .
          if (child.name.startsWith('.') && !segment.startsWith('.')) {
            return false;
          }

          return regex.test(child.name);
        });

        const results: string[] = [];
        for (const child of matchedChildren) {
          const childPath = join(path, child.name);
          const childShown = joinShown(shown, child.name);
          if (rest.length === 0) {
            results.push(childShown);
          } else {
            results.push(...await this.expandGlobSegments(childPath, childShown, rest));
          }
        }

        results.sort((a, b) => a.localeCompare(b));

        return results;
      } catch {
        // Permission denied or not a directory
        return [];
      }
    }

    return this.expandGlobSegments(join(path, segment), joinShown(shown, segment), rest);
  }

  private async expandRecursiveGlob(path: string, shown: string, remainingSegments: string[]): Promise<string[]> {
    const results: string[] = [];

    results.push(...await this.expandGlobSegments(path, shown, remainingSegments));

    try {
      const children = await this.config.vfs.children(this.access!, path);
      for (const child of children) {
        // Hidden directories are entered only for a pattern that starts with .
        const nextPattern = remainingSegments[0];
        if (child.name.startsWith('.') && (!nextPattern || !nextPattern.startsWith('.'))) {
          continue;
        }
        results.push(...await this.expandRecursiveGlob(join(path, child.name), joinShown(shown, child.name), remainingSegments));
      }
    } catch {
      // Permission denied - skip
    }

    return results;
  }

  /**
   * A user's home, `<HOMES_PATH>/<name>` for the account under USERS_PATH; with no name, the home
   * of the user with the shell's uid, whatever HOME says. A name no user has throws, which leaves
   * `~name` as written.
   */
  async resolveHomeUser(ctx: ExecContextIf, username: string | null): Promise<string> {
    const usersPath = ctx.getEnv().USERS_PATH;

    if (username === null) {
      const users = await this.config.vfs.children<UserAttrs>(ADMIN_ACCESS, usersPath);
      const self = users.find((entry) => isUserNode(entry.node) && entry.node.attrs.uid === this.access!.uid);

      if (!self) throw new Error(`no user has uid ${this.access!.uid}`);

      return homePath(self.name);
    }

    const user = await this.config.vfs.get(ADMIN_ACCESS, join(usersPath, username));

    if (!isUserNode(user)) throw new Error(`no user ${username}`);

    return homePath(username);
  }

  async readFile(ctx: ExecContextIf, path: string): Promise<string> {
    await this.assertNotRefusedGuest();
    const abspath = resolve(ctx.getCwd(), path);

    const handle = await this.config.vfs.open(this.access!, abspath, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  }

  /**
   * A scratch file for process substitution, `cat <(cmd)`.
   *
   * The substituted command has to hand the reading command something it can
   * open, and a pipe is not a path here — so it writes into a node under
   * $TEMP_PATH, which is a memory mount. That means the output is buffered whole
   * rather than streamed, the one thing `<(…)` would otherwise buy over `$( )`.
   */
  async tempFile(ctx: ExecContextIf): Promise<string> {
    await this.assertNotRefusedGuest();
    const dir = ctx.getEnv().TEMP_PATH || TEMP_PATH;
    const name = `psub-${crypto.randomUUID()}`;
    const path = join(dir, name);

    await this.config.vfs.ensure<FileAttrs>(this.accessIn(ctx), NODE_TYPE_FILE, dir, name, {
      attrs: { name, mimetype: 'text/plain', size: 0 },
    });

    return path;
  }

  /**
   * Removes a file made by tempFile.
   */
  async removeTempFile(ctx: ExecContextIf, path: string): Promise<void> {
    try {
      await this.config.vfs.unlink(this.accessIn(ctx), path, dirname(path));
    } catch (error) {
      logger.debug('removeTempFile: could not remove', { path, error });
    }
  }

  /** Test a path against one of `test`'s conditions. */
  async testPath(ctx: ExecContextIf, path: string, op: PathTestOperation, path2?: string): Promise<boolean> {
    // The guest who must sign in sees no path, so a redirection fails before its command runs.
    if (await this.refusesGuest()) return false;
    const abspath = resolve(ctx.getCwd(), path);

    try {
      switch (op) {
        case 'DIRECTORY': // Any node can have children, so every node counts as a directory
        case 'EXISTS': {
          return await this.config.vfs.exists(this.access!, abspath);
        }

        case 'REGULAR_FILE': {
          const node = await this.config.vfs.get(this.access!, abspath);
          return node.type === NODE_TYPE_FILE;
        }

        case 'READABLE': {
          const node = await this.config.vfs.get(this.access!, abspath);
          try {
            assertAccess(this.access!, node, 'r');
            return true;
          } catch {
            return false;
          }
        }

        case 'WRITABLE': {
          const node = await this.config.vfs.get(this.access!, abspath);
          try {
            assertAccess(this.access!, node, 'w');
            return true;
          } catch {
            return false;
          }
        }

        case 'EXECUTABLE': {
          const node = await this.config.vfs.get(this.access!, abspath);
          try {
            assertAccess(this.access!, node, 'x');
            return true;
          } catch {
            return false;
          }
        }

        case 'NON_EMPTY': {
          const node = await this.config.vfs.get(this.access!, abspath);
          if (node.type === NODE_TYPE_FILE) {
            return ((node as Node<FileAttrs>).attrs.size ?? 0) > 0;
          }
          return false;
        }

        case 'SYMLINK': {
          // The link itself, not its target: a dangling link is still a link.
          const node = await this.config.vfs.get(this.access!, abspath, { readlink: true });
          return !!node.props.softlink;
        }

        case 'NAMED_PIPE':
          return false;

        // `/dev/null` is a character device on Linux, and `[ -c /dev/null ]` is how a script asks.
        case 'CHAR_DEVICE': {
          const node = await this.config.vfs.get(this.access!, abspath);
          return node.type === NODE_TYPE_NULL;
        }

        case 'NEWER_THAN': {
          if (!path2) return false;
          const abspath2 = resolve(ctx.getCwd(), path2);
          const node1 = await this.config.vfs.get(this.access!, abspath);
          const node2 = await this.config.vfs.get(this.access!, abspath2);
          return (node1.props.modtime ?? 0) > (node2.props.modtime ?? 0);
        }

        case 'OLDER_THAN': {
          if (!path2) return false;
          const abspath2 = resolve(ctx.getCwd(), path2);
          const node1 = await this.config.vfs.get(this.access!, abspath);
          const node2 = await this.config.vfs.get(this.access!, abspath2);
          return (node1.props.modtime ?? 0) < (node2.props.modtime ?? 0);
        }

        case 'SAME_DEVICE_AND_INODE': {
          if (!path2) return false;
          const abspath2 = resolve(ctx.getCwd(), path2);
          const node1 = await this.config.vfs.get(this.access!, abspath);
          const node2 = await this.config.vfs.get(this.access!, abspath2);
          return node1.id === node2.id;
        }

        case 'OWNED_BY_EUID': {
          const node = await this.config.vfs.get(this.access!, abspath);
          return node.props.uid === this.access!.uid;
        }

        case 'OWNED_BY_EGID': {
          const node = await this.config.vfs.get(this.access!, abspath);
          return node.props.gid === this.access!.gid;
        }

        // These don't apply to VFS
        case 'BLOCK_DEVICE':
        case 'SOCKET':
        case 'SETGID':
        case 'SETUID':
        case 'STICKY':
        case 'MODIFIED_SINCE_LAST_READ':
        case 'FD_IS_TERMINAL':
          return false;

        default:
          return false;
      }
    } catch {
      // Node doesn't exist or access denied
      return false;
    }
  }

  // ===== Command Execution Methods =====

  /** Run a command that is not a builtin or function: a core command, a command node, or a bin file. */
  private async execExternal(
    ctx: ExecContextIf,
    name: string,
    args: string[],
    bg: { background?: boolean; onSpawn?: (pid: string) => void } = {},
  ): Promise<number> {
    try {
      let commandPath: NodePath = '';

      // Exec refuses the guest a command that is not part of signing in; this refuses it the
      // rest — a command node by its path, a bin file — before reading it.
      if ((name.includes('/') || !this.config.cem.get(name)?.guest) && await this.refusesGuest()) {
        await this.pipeWrite(ctx.getStderr(), `${name}: sign in first\n`);
        return 126;
      }

      if (name.includes('/')) {
        commandPath = resolve(ctx.getCwd(), name);
      } else {
        if (this.config.cem.get(name)) {
          const { id, done } = await this.config.cem.spawn(name, {
            parentId: this.config.sessionPath,
            stdin: this.pipeToId(ctx.getStdin()),
            stdout: this.pipeToId(ctx.getStdout()),
            stderr: this.pipeToId(ctx.getStderr()),
            cwd: ctx.getCwd(),
            cols: this.cols,
            rows: this.rows,
            args,
            access: this.accessIn(ctx),
            tty: this,
            ctx,
            forground: !bg.background,
          });
          bg.onSpawn?.(id);
          const state = await this.waitForCommand(ctx, id, done);

          if (!bg.background && state.exitReason && !ctx.getAbortSignal()?.aborted) {
            await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}${state.exitReason || 'unknown exit reason'}\n`);
          }

          return state.exitCode ?? 255;
        }

        if (!ctx.getEnv().PATH) {
          throw new Error('PATH is not set');
        }

        commandPath = await lookupCommandPath(this.config.vfs, ctx.getEnv().PATH, name) ?? '';
      }

      if (!name || !commandPath) {
        throw new CommandNotFoundError(`command '${name}' not found`);
      }

      // One lookup: a missing node is what `get` reports, and this runs on every external command.
      let node: Node;
      try {
        node = await this.config.vfs.get(this.access!, commandPath);
      } catch (error) {
        if (error instanceof NodeNotFoundError) {
          throw new CommandNotFoundError(`command '${name}' not found`);
        }
        throw error;
      }
      assertAccess(this.access!, node, 'x');

      if (node.type === NODE_TYPE_COMMAND) {
        // The registry is keyed by command name, and `name` is whatever was typed — for
        // `/bin/uuid` the whole path. The node's own basename is the name.
        const { id, done } = await this.config.cem.spawn(basename(commandPath), {
          parentId: this.config.sessionPath,
          stdin: this.pipeToId(ctx.getStdin()),
          stdout: this.pipeToId(ctx.getStdout()),
          stderr: this.pipeToId(ctx.getStderr()),
          cwd: ctx.getCwd(),
          cols: this.cols,
          rows: this.rows,
          args,
          access: this.accessIn(ctx),
          tty: this,
          ctx,
          forground: !bg.background,
        });
        bg.onSpawn?.(id);
        const state = await this.waitForCommand(ctx, id, done);

        if (!bg.background && state.exitReason && !ctx.getAbortSignal()?.aborted) {
          await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}${state.exitReason ? `: ${state.exitReason}` : ''}\n`);
        }

        return state.exitCode ?? 255;
      } else if (node.type === NODE_TYPE_FILE) {
        // A `#!ts` file runs inside this process, with all of its permissions, so only a module's
        // runs: `MOD_PATH` is the administrator's to write. The constant, not the caller's
        // `$MOD_PATH`, which anyone can point at their own home.
        const inModule = moduleRootOf(commandPath, MOD_PATH) !== undefined;

        // Before the read, not after: a `#!ts` bin this process has already loaded and whose file
        // has not changed since needs neither its source nor anything it imports.
        const cached = inModule ? cachedTsCommand(MOD_PATH, commandPath, node as Node<FileAttrs>) : undefined;
        if (cached) {
          return await this.runTsCommand(ctx, cached, args, bg);
        }

        const handle = await this.config.vfs.open(this.access!, commandPath, { mode: 'r' });
        let commandScript: string;
        try {
          commandScript = await toText(handle.readable);
        } finally {
          await handle.close();
        }

        if (commandScript.startsWith('#!ts\n') || commandScript.startsWith('#!ts\r\n')) {
          if (!inModule) {
            await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}: ${name}: a #!ts command runs only from a module in ${MOD_PATH}\n`);
            return 126;
          }
          return await this.execTypeScriptCommand(ctx, commandScript, args, bg, commandPath, node as Node<FileAttrs>);
        }

        // A script run as a command is a process of its own, with a $BASHPID of its own
        const subCtx = ctx.subContext(true);

        // A bin in bash sees what a bin in TypeScript sees: the environment and the shell's
        // variables, so a prefix assignment (`JSON_OUTPUT=1 person --help`) reaches it either way.
        const variables = commandVariables(ctx);
        if (Object.keys(variables).length) subCtx.setLocalEnv(variables);

        // Set function arguments ($0, $1, $2, ..., $#, $@, $*)
        for (let i = 0; i < args.length; i++) {
          subCtx.setLocalParams({ [`${i + 1}`]: args[i] });
        }
        subCtx.setLocalParams({ '0': commandPath });
        subCtx.setLocalParams({ '#': args.length.toString() });
        subCtx.setLocalParams({ '@': args.join(' ') });
        subCtx.setLocalParams({ '*': args.join(' ') });

        return await this.executor.execute(
          commandScript,
          subCtx,
        );
      }

      throw new Error(`${name}: command not found`);
    } catch (error) {
      if (ctx.getAbortSignal()?.aborted) {
        throw ctx.getAbortSignal()!.reason ?? error;
      }

      // A script run as a command is a process of its own: a broken pipe ends it, not its caller
      if (error instanceof BrokenPipeError) {
        return BROKEN_PIPE_STATUS;
      }

      console.error('execExternal', name, args, error);

      if (error instanceof BashSyntaxError) {
        await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}: ${error.getFormattedMessage()}\n`);
        await this.pipeWrite(ctx.getStderr(), `${error.getCodeSnippet(4)}\n`);
      } else if (error instanceof Error) {
        await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}: ${error.message}\n`);
      } else {
        await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}: ${error}\n`);
      }

      return error instanceof CommandNotFoundError ? 127 : 1;
    }
  }

  /** Tie one spawned command to the captured execution which owns its context. */
  private async waitForCommand(ctx: ExecContextIf, id: string, done: Promise<CmdState>): Promise<CmdState> {
    const signal = ctx.getAbortSignal();
    if (!signal) return await done;

    const stop = () => {
      this.config.cem.signalPid(id, 'SIGTERM')
        .catch((error) => logger.debug('failed to stop guarded command', { id, error: (error as Error).message }));
    };

    if (signal.aborted) {
      stop();
    } else {
      signal.addEventListener('abort', stop, { once: true });
    }

    try {
      return await done;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  /** Run a module's `#!ts` bin read from the VFS; `execExternal` has checked it is a module's. */
  private async execTypeScriptCommand(
    ctx: ExecContextIf,
    content: string,
    args: string[],
    bg: { background?: boolean; onSpawn?: (pid: string) => void } = {},
    commandPath = '',
    node?: Node<FileAttrs>,
  ): Promise<number> {
    // `loadTsCommand` stages the bin with its module's files and keeps the imported command
    // against the bin's mtime and size; `execExternal` checks that before it reads the file.
    const cmdFn = await loadTsCommand(
      this.config.vfs,
      this.access!,
      commandPath,
      content,
      MOD_PATH,
      node ?? await this.config.vfs.get<FileAttrs>(this.access!, commandPath),
    );

    return await this.runTsCommand(ctx, cmdFn, args, bg);
  }

  /** Spawn an already-loaded `#!ts` command. Shared by the cache hit and the load path. */
  private async runTsCommand(
    ctx: ExecContextIf,
    cmdFn: CmdFunction,
    args: string[],
    bg: { background?: boolean; label?: string; onSpawn?: (pid: string) => void } = {},
  ): Promise<number> {
    const { id, done } = await this.config.cem.spawnDynamic(cmdFn, {
      parentId: this.config.sessionPath,
      stdin: this.pipeToId(ctx.getStdin()),
      stdout: this.pipeToId(ctx.getStdout()),
      stderr: this.pipeToId(ctx.getStderr()),
      cwd: ctx.getCwd(),
      cols: this.cols,
      rows: this.rows,
      args,
      label: bg.label,
      access: this.accessIn(ctx),
      tty: this,
      ctx,
      forground: !bg.background,
    });
    bg.onSpawn?.(id);
    // A job's context is aborted by its own signal handler (see
    // `runInBackground`); tying the job to that abort as well would answer the
    // signal it got with a SIGTERM of its own
    const state = bg.background ? await done : await this.waitForCommand(ctx, id, done);

    if (!bg.background && state.exitReason && !ctx.getAbortSignal()?.aborted) {
      await this.pipeWrite(ctx.getStderr(), `${color('red', 'error')}: ${state.exitReason}\n`);
    }

    return state.exitCode ?? 255;
  }

  // ===== Job control (background jobs) =====

  /**
   * Job control, the host's side of it. The job table, the job builtins
   * (`jobs`, `wait`, `kill`, `disown`, `fg`, `bg`) and `$!` are the executor's;
   * starting a job, signalling a process and letting a job outlive the shell
   * are what only this shell can do.
   */
  readonly jobs: JobHostIf = {
    start: async (ctx, run, command) => {
      const job = await this.spawnJob(ctx, command, (bgCtx, onSpawn) => this.runInBackground(bgCtx, run, command, onSpawn));

      return { pid: job.pid, done: job.done };
    },

    signal: async (pid, signal) => {
      // Someone else's process is not there for anyone but admin, as `ps` does not show it.
      const owner = this.config.cem.states().find((state) => state.id === pid && state.state === 'running')?.opts?.access.uid;
      if (owner !== undefined && owner !== this.access!.uid && !isAdmin(this.access!)) {
        return false;
      }

      // `0` only asks whether the process is there. Of the rest, those a
      // command here has no handling for are taken and ignored, as a process
      // that ignores them would.
      const name = JOB_SIGNALS[signal];

      return await this.config.cem.signalPid(pid, name);
    },

    foreground: async (pid) => {
      const job = this.hostJobs.get(pid);

      this.config.cem.setForeground(pid, true);

      if (!job) {
        return (await this.config.cem.wait(pid).catch(() => undefined))?.exitCode ?? 0;
      }

      // Output already forwards to the terminal; just block until the job exits
      job.foreground = true;

      return await job.done;
    },

    background: async (pid) => {
      this.config.cem.setForeground(pid, false);
      await this.config.cem.signalPid(pid, 'SIGCONT');
    },

    disown: async (pid) => {
      await this.detachJob(pid);
    },
  };

  /**
   * Run a piece of the parse tree as a command in its own right: a dynamic
   * command whose body is the thunk. Going through the CEM rather than just
   * awaiting the thunk is what gives it a pid to signal, a state to look at and
   * somewhere for `detach` to hold on to.
   *
   * The signal is bridged onto an abort signal on the job's own context, which
   * is what the executor checks between nodes. Without that, hanging up a
   * backgrounded loop would stop only the command inside it and the loop would
   * start the next one.
   *
   * The job's source text is its process's label, so `ps` says what it runs.
   */
  private async runInBackground(
    ctx: ExecContextIf,
    run: (ctx: ExecContextIf) => Promise<number>,
    command: string,
    onSpawn: (pid: string) => void,
  ): Promise<number> {
    const controller = new AbortController();
    ctx.setAbortSignal(controller.signal);
    // The signal that ended the job, for its status
    let ended: Signal | undefined;

    const cmdFn: CmdFunction = async (cmd) => {
      // Everything the job starts from here belongs to the job rather than to
      // the shell. Signals are delivered per tty name, so giving the job one of
      // its own — its pid — is what makes the two sets separable: hanging up the
      // shell does not reach a step of a detached sweep, and `kill <job pid>`
      // reaches the whole group.
      ctx.setEnv({ TTY_NAME: cmd.id });

      cmd.onSignal(async (signal) => {
        if (!isTerminatingSignal(signal)) {
          return;
        }
        if (!controller.signal.aborted) {
          ended = signal;
          controller.abort(new Error(`hung up by ${signal}`));
        }
        // The abort stops the job between steps; the step running right now is a
        // command of its own and has to be told directly.
        await this.config.cem.signal(cmd.id, signal, { includeBackground: true, skipDetached: true })
          .catch((error) => logger.debug('failed to signal job group', { pid: cmd.id, error: (error as Error).message }));
      });

      // A job a signal ended ends as a process it killed would: 143 for TERM,
      // as `wait` says, whatever the command it was running made of it
      try {
        const code = await run(ctx);

        return ended ? signalExitCode(ended) : code;
      } catch (error) {
        // The abort is how the signal reached the executor, so the throw it
        // raises is the intended stop, not a failure to report.
        if (controller.signal.aborted) {
          return ended ? signalExitCode(ended) : 130;
        }
        throw error;
      }
    };
    cmdFn.spec = { name: 'bg', description: 'a compound command running in the background', args: [], flags: [], json: false };

    return await this.runTsCommand(ctx, cmdFn, [], { background: true, label: command, onSpawn });
  }

  /**
   * The bookkeeping every background job needs: private output buffers
   * forwarded to the terminal while attached, and a reap when it finishes.
   * Resolves once the job has its pid.
   */
  private async spawnJob(
    ctx: ExecContextIf,
    command: string,
    start: (bgCtx: ExecContextIf, onSpawn: (pid: string) => void) => Promise<number>,
  ): Promise<ShellJob> {
    // Private output buffers so the job's I/O is independent of the shell's
    // fd 1/2 (needed so it can be redirected to a log and survive close on disown).
    const outFd = await this.pipeOpen();
    const errFd = await this.pipeOpen();
    const outId = this.pipeToId(outFd);
    const errId = this.pipeToId(errFd);

    // A job is a subshell, with a $BASHPID of its own
    const bgCtx = ctx.subContext(true);
    bgCtx.redirectStdout(outFd);
    bgCtx.redirectStderr(errFd);

    // Forward the private buffers to the terminal while the job is attached.
    const forwarder = new AbortController();
    const outPump = this.forwardFd(outFd, ctx.getStdout(), forwarder.signal);
    const errPump = this.forwardFd(errFd, ctx.getStderr(), forwarder.signal);

    const pidReady = deferred<string>();

    const job: ShellJob = {
      pid: '',
      table: ctx.getJobTable(),
      foreground: false,
      command,
      startedAt: Date.now(),
      outFd,
      errFd,
      outId,
      errId,
      forwarder,
      detached: false,
      finished: false,
      done: Promise.resolve(0),
    };

    // Resolves only once the job is reaped, so that everything it wrote has
    // reached the terminal by the time `wait` or `fg` returns
    job.done = (async () => {
      try {
        job.exitCode = await jobScope.run([...(jobScope.getStore() ?? []), job], () =>
          start(bgCtx, (pid) => {
            job.pid = pid;
            this.hostJobs.set(pid, job);
            pidReady.resolve(pid);
          }));
      } catch (error) {
        logger.warn('background job failed', { command, error: (error as Error).message });
        job.exitCode = 1;
      } finally {
        pidReady.resolve(job.pid);
        await this.reapJob(job, [outPump, errPump]);
      }

      return job.exitCode;
    })();

    if (!await pidReady) {
      await job.done;
      throw new Error(`${command}: the job did not start`);
    }

    return job;
  }

  /** Pump a private job buffer to a shell fd (terminal) until aborted or EOF. */
  private async forwardFd(srcFd: string, dstFd: string, signal: AbortSignal): Promise<void> {
    const src = await this.config.bufferManager.open(this.pipeToId(srcFd), {}, 'r');
    try {
      while (!signal.aborted) {
        const chunk = await src.read(4096, signal);
        if (chunk.length === 0) {
          break;
        }
        const dst = this.fdMap.get(dstFd);
        if (!dst) {
          break;
        }
        await dst.handle.write(chunk);
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.debug('job forwarder ended', { error: (error as Error).message });
      }
    } finally {
      await src.close().catch(() => {});
    }
  }

  /** A job's command finished: let the terminal forwarder and the log drain, delete private buffers. */
  private async reapJob(job: ShellJob, pumps: Promise<void>[]): Promise<void> {
    job.finished = true;
    // Nothing else will write to the job's buffers now, so close them for
    // writing: that is what lets the forwarder and the log pumps pass on what
    // is left and reach EOF rather than block on a buffer that no longer has an
    // author. Without it, waiting for them below would never return.
    await this.writeEOFTo(job.outFd);
    await this.writeEOFTo(job.errFd);
    await Promise.allSettled(pumps);

    // After the pumps, so the job's own last output reaches the terminal before
    // the line saying it is done
    await this.reportJob(job);
    // Trailing output reaches the log before the buffers are deleted.
    await Promise.allSettled(job.logPumps ?? []);
    // Only a detached job has a record to close out. An attached one was
    // reported to the terminal just above, which is where its owner is looking.
    if (job.detached) {
      await this.writeJobStatus(job, join(JOBS_LOG_BASE, job.pid));
    }
    await this.detachFd(job.outFd);
    await this.detachFd(job.errFd);
    await this.config.bufferManager.delete(job.outId).catch(() => {});
    await this.config.bufferManager.delete(job.errId).catch(() => {});
    this.hostJobs.delete(job.pid);
    if (this.closed && !this.hasLiveDetachedJob()) {
      liveShells.delete(this);
    }
  }

  /** SIGKILL every job of this shell, background and detached alike. */
  async killJobs(): Promise<void> {
    await Promise.all([...this.hostJobs.keys()].map((pid) => this.config.cem.signalPid(pid, 'SIGKILL')));
  }

  /**
   * Say that a background job has finished: `[1]+  Done   sleep 5`.
   *
   * bash prints the line at the next prompt, or straight away under `set -b`,
   * which is what makes that option mean anything. The job leaves the table
   * when it is announced. A job `fg` waited for, or one `wait` already took
   * out of the table, is not announced at all.
   *
   * A shell with no prompt to print before leaves the job in the table, done,
   * for `jobs` or `wait` to find — as a non-interactive bash does.
   */
  private async reportJob(job: ShellJob): Promise<void> {
    const entry = job.table.find(job.pid);

    if (job.detached || job.foreground || !entry) {
      return;
    }

    // The table learns the status once `done` resolves, after this; the line needs it now
    entry.state = 'Done';
    entry.status = job.exitCode ?? 0;

    if (this.ctx.getShellOption('notify')) {
      await this.announceJob(job.table, entry);

      return;
    }

    if (this.queuesJobReports) {
      this.jobReports.push({ table: job.table, job: entry });
    }
  }

  private async announceJob(table: JobTable, job: Job): Promise<void> {
    if (!table.list().includes(job)) {
      return;
    }

    const line = table.describe(job);

    table.remove(job);
    await this.pipeWrite(this.ctx.getStderr(), line).catch(() => {});
  }

  /** Whether a finished job's line has a prompt to wait for. Only interactive shells do. */
  protected get queuesJobReports(): boolean {
    return false;
  }

  /** Announce the jobs that finished since the last prompt. */
  protected async flushJobReports(): Promise<void> {
    const reports = this.jobReports;

    this.jobReports = [];

    for (const { table, job } of reports) {
      await this.announceJob(table, job);
    }
  }

  /** Close a shell fd handle and forget it, WITHOUT deleting the backing buffer. */
  private async detachFd(fd: string): Promise<void> {
    const entry = this.fdMap.get(fd);
    if (entry) {
      await entry.handle.close().catch(() => {});
      this.fdMap.delete(fd);
      this.fdReadBuffers.delete(fd);
    }
    this.detachedFds.delete(fd);
  }

  /** Close an fd's buffer for writing, so its readers drain and see EOF. */
  private async writeEOFTo(fd: string): Promise<void> {
    await this.fdMap.get(fd)?.handle.writeEOF?.().catch(() => {});
  }

  /**
   * Does this shell still have a detached job running?
   *
   * NOT the job table: disowning a job takes it out of that, which is what
   * disowning it means. `detachedFds` is the bookkeeping that actually spans the
   * job's life — `detachJob` adds its two fds, `reapJob` removes them via
   * `detachFd` when the command exits — so it is non-empty exactly while a
   * detached job of this shell is still going.
   *
   * `close()` deliberately keeps such a job alive: it skips detached commands
   * when it SIGHUPs, and leaves their fds and buffers for `reapJob`. A detached
   * job that is a whole compound command then goes on to start commands of its
   * own, and those come back through `run` / `runAndCapture` on this shell. So
   * "closed" does not mean "nothing may execute here" while one is still going;
   * it means the *session* is gone.
   */
  private hasLiveDetachedJob(): boolean {
    return this.detachedFds.size > 0;
  }

  /**
   * Detach a job so it survives the shell, for `detach` and `nohup`: by job
   * spec, job number or pid, the current job when none is given. It leaves the
   * job table, as with `disown`.
   */
  async disownJob(sel?: string, ctx: ExecContextIf = this.ctx): Promise<ShellJobInfo | undefined> {
    const table = ctx.getJobTable();
    const entry = sel === undefined ? table.find('%+') : (/^\d+$/.test(sel) && table.find(`%${sel}`)) || table.find(sel);
    // By pid, a job of this shell's that a table here does not hold: an API
    // shell runs each call in a subshell, whose table goes with it
    const pid = entry?.pid ?? (sel !== undefined && this.hostJobs.has(sel) ? sel : undefined);

    if (!pid) {
      return undefined;
    }

    const job = await this.detachJob(pid);

    if (!job) {
      return undefined;
    }

    if (entry) {
      table.remove(entry);
    }

    return { jobNum: entry?.id ?? 0, pid: job.pid, command: job.command, detached: true, state: job.finished ? 'done' : 'running' };
  }

  /**
   * Let a job outlive this shell: stop forwarding its output to the terminal,
   * redirect it to a log file, exempt its buffers from close() so they are not
   * deleted, and mark the command detached so SIGHUP on close skips it.
   * Undefined when there is no such job still running.
   */
  private async detachJob(pid: string): Promise<ShellJob | undefined> {
    const job = this.hostJobs.get(pid);

    if (!job) {
      return undefined;
    }
    if (job.detached) {
      return job;
    }

    // Reaping starts before the job leaves the table, so a job that has just
    // finished is still resolvable — and detaching it would start log pumps on
    // buffers that are about to be deleted. There is nothing left to detach.
    if (job.finished) {
      return undefined;
    }

    // Stop forwarding to the terminal and exempt the job's fds from shell
    // teardown. Note that they are not closed here: the job goes on writing to
    // them, and `reapJob` is what ends them.
    job.forwarder.abort();
    this.detachedFds.add(job.outFd);
    this.detachedFds.add(job.errFd);

    // The job's output goes to JOBS_LOG_BASE/<pid>/{stdout,stderr}.log from here on.
    const logDir = await this.ensureJobLogDir(job);
    const logFwd = new AbortController();
    job.logForwarder = logFwd;
    const outLog = await this.config.vfs.open(ADMIN_ACCESS, join(logDir, 'stdout.log'), { mode: 'a' });
    const errLog = await this.config.vfs.open(ADMIN_ACCESS, join(logDir, 'stderr.log'), { mode: 'a' });
    job.logPumps = [
      this.forwardFdToLog(job.outId, outLog, logFwd.signal),
      this.forwardFdToLog(job.errId, errLog, logFwd.signal),
    ];

    job.detached = true;
    this.config.cem.detach(job.pid);

    await this.writeJobStatus(job, logDir);

    return job;
  }

  /** Pump a private job buffer to an open log handle until aborted or EOF. */
  private async forwardFdToLog(srcId: string, logHandle: ResourceHandleIf, signal: AbortSignal): Promise<void> {
    // Inside the try: the job can finish and be reaped while `disownJob` is
    // still setting the log up, and then this buffer is already gone. That is a
    // job with nothing left to say, not an error to raise from a pump nobody
    // awaits.
    let src: ResourceHandleIf;
    try {
      src = await this.config.bufferManager.open(srcId, {}, 'r');
    } catch {
      await logHandle.close().catch(() => {});
      return;
    }

    try {
      while (!signal.aborted) {
        const chunk = await src.read(4096, signal);
        if (chunk.length === 0) {
          break;
        }
        await logHandle.write(chunk);
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.debug('job log forwarder ended', { error: (error as Error).message });
      }
    } finally {
      await src.close().catch(() => {});
      await logHandle.close().catch(() => {});
    }
  }

  /**
   * Write (or rewrite) the job's `status.json` beside its logs. Best-effort:
   * losing the record must not take the job down with it, and a job that is
   * running is the case where the record matters least — the shell that started
   * it usually still has the answer.
   */
  private async writeJobStatus(job: ShellJob, logDir: string): Promise<void> {
    const status: DetachedJobStatus = {
      pid: job.pid,
      command: job.command,
      bootId: BOOT_ID,
      startedAt: job.startedAt,
      state: job.finished ? 'exited' : 'running',
      ...(job.finished ? { exitCode: job.exitCode ?? 255, exitedAt: Date.now() } : {}),
    };

    try {
      const handle = await this.config.vfs.open(ADMIN_ACCESS, join(logDir, JOB_STATUS_FILE), { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(`${JSON.stringify(status, null, 2)}\n`));
      } finally {
        await handle.close();
      }
    } catch (error) {
      logger.warn('failed to write job status', { pid: status.pid, error: (error as Error).message });
    }
  }

  private async ensureJobLogDir(job: ShellJob): Promise<string> {
    const dir = join(JOBS_LOG_BASE, job.pid);
    await this.ensureDirPath(dir);
    for (const file of ['stdout.log', 'stderr.log', JOB_STATUS_FILE]) {
      await this.ensureLogFile(join(dir, file));
    }
    return dir;
  }

  private async ensureDirPath(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let parent = '/';
    for (const part of parts) {
      try {
        await this.config.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, parent, part);
      } catch {
        // already exists
      }
      parent = join(parent, part);
    }
  }

  private async ensureLogFile(path: string): Promise<void> {
    if (await this.config.vfs.exists(ADMIN_ACCESS, path)) {
      return;
    }
    const name = basename(path);
    const attrs: FileAttrs = { name, mimetype: await getMimeFromExt(name, 'text/plain'), size: 0 };
    await this.config.vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, dirname(path), name, { attrs });
  }

  // ===== ShellIf File Bridging Methods =====

  /**
   * Checks if a name refers to a managed pipe (as opposed to a file path).
   * Standard streams (0, 1, 2) and named pipes in fdMap are considered managed pipes.
   */
  isPipe(name: string): boolean {
    return this.fdMap.has(name);
  }

  /**
   * Streams data from a file to a pipe. Reads from the file and writes to the pipe.
   * When done reading, the pipe is closed to signal EOF.
   */
  async pipeFromFile(ctx: ExecContextIf, path: string, pipe: string): Promise<void> {
    // A redirection whose pipe has already gone (client disconnected, command
    // torn down) is not a failure — there is nothing left to write to. Bail out
    // rather than letting pipeToHandle throw: this runs detached, so the
    // rejection would be unhandled and Deno treats that as fatal.
    // Note .get(), not .has(): fdMap values are nullable and pipeToHandle
    // throws on a null entry just as it does on a missing key.
    if (!this.fdMap.get(pipe)) {
      logger.debug('pipeFromFile: no pipe for FD, skipping', { fd: pipe });
      return;
    }

    // `path` here is whatever the executor decided was not a pipe — and it decides that
    // with `fdMap.has(name)`. Teardown empties fdMap, so an inherited stdin that was the
    // fd "0" all along stops looking like a pipe and starts looking like a filename.
    //
    // run()/runAndCapture() refuse on a closed shell, but a command that got past that
    // check can still reach here mid-teardown, and an abandoned step (one whose timeout
    // won the race) can arrive long after. Both are shutdown noise, not errors.
    if (/^\d+$/.test(path)) {
      logger.debug('pipeFromFile: bare fd, not a file — shell torn down', { fd: path });
      await this.pipeClose(pipe).catch(() => {});
      return;
    }

    try {
      await this.assertNotRefusedGuest();
      const abspath = resolve(ctx.getCwd(), path);

      const src = await this.config.vfs.open(this.access!, abspath, {
        mode: 'r',
      });
      const dest = this.pipeToHandle(pipe);

      await src.readable.pipeTo(dest.writable);
    } catch (err) {
      // The command reading the file has ended: there is nobody left to copy it to.
      if (err instanceof BrokenPipeError) {
        return;
      }

      // See pipeToFile: the FD can vanish across the vfs.open await.
      if (!this.fdMap.get(pipe)) {
        logger.debug('pipeFromFile: FD vanished mid-stream, ignoring', { fd: pipe });
        return;
      }

      logger.error('pipeFromFile error:', err);
      throw err;
    } finally {
      await this.pipeClose(pipe).catch((err) => logger.error('Failed to close pipe after pipeFromFile', err));
    }
  }

  /**
   * Streams data from a pipe to a file. Reads from the pipe and writes to the file.
   * Completes when the pipe is closed (EOF).
   */
  async pipeToFile(ctx: ExecContextIf, pipe: string, path: string, append: boolean): Promise<void> {
    // See pipeFromFile: a vanished FD means there is nothing to copy, and
    // throwing from this detached path kills the process.
    if (!this.fdMap.get(pipe)) {
      logger.debug('pipeToFile: no pipe for FD, skipping', { fd: pipe });
      return;
    }

    // The write-side mirror of the guard in pipeFromFile: once teardown empties fdMap, a
    // redirection target that was the fd "1"/"2" all along stops looking like a pipe and
    // starts looking like a filename, which vfs.ensure below would create.
    if (/^\d+$/.test(path)) {
      logger.debug('pipeToFile: bare fd, not a file — shell torn down', { fd: path });
      return;
    }

    try {
      await this.assertNotRefusedGuest();
      const abspath = resolve(ctx.getCwd(), path);
      const access = this.accessIn(ctx);

      await this.config.vfs.ensure<FileAttrs>(access, NODE_TYPE_FILE, dirname(abspath), basename(abspath), {
        attrs: {
          name: basename(abspath),
          size: 0,
          mimetype: await getMimeFromExt(abspath, 'text/plain'),
        },
      });

      const src = this.pipeToHandle(pipe);
      const dest = await this.config.vfs.open(access, abspath, {
        mode: append ? 'a+' : 'w+',
      });

      await src.readable.pipeTo(dest.writable);

      // Sync the size attr and emit an updated event: consumers react to node
      // events, not to raw registry writes. Only file nodes carry a size attr.
      const node = await this.config.vfs.get(access, abspath);
      if (node.type === NODE_TYPE_FILE) {
        const stat = await this.config.vfs.stat(access, abspath);
        await this.config.vfs.update<FileAttrs>(access, abspath, {
          attrs: { size: Number(stat.size ?? 0) },
        });
      }
    } catch (err) {
      // The entry guard above only covers the state on entry. vfs.ensure and
      // vfs.open both await, and the FD can be torn down during either — the
      // caller abandons this promise whenever the command itself throws, so a
      // rethrow here lands as an unhandled rejection and Deno kills the server.
      // A vanished FD mid-stream is teardown, not a failure. Genuine errors
      // (permissions, disk) still propagate: the FD is intact for those.
      if (!this.fdMap.get(pipe)) {
        logger.debug('pipeToFile: FD vanished mid-stream, ignoring', { fd: pipe });
        return;
      }

      logger.error('pipeToFile error:', err);
      throw err;
    }
  }

  // ===== Pipe Management =====

  /** The handle behind a file descriptor. */
  pipeToHandle(fd: string): ResourceHandleIf {
    const entry = this.fdMap.get(fd);
    if (!entry) {
      throw new Error(`No pipe for FD ${fd}`);
    }

    return entry.handle;
  }

  /** The buffer ID behind a file descriptor. */
  protected pipeToId(fd: string): string {
    const entry = this.fdMap.get(fd);
    if (!entry) {
      throw new Error(`no pipe for FD ${fd}`);
    }

    return entry.id;
  }

  /** Open a new pipe, on `fd` or the lowest free one from 3. */
  async pipeOpen(fd?: string): Promise<string> {
    fd = fd ?? this.getFreeFdNumber();

    // Reserved before the awaits, so two pipes opened at once get different fds.
    this.fdMap.set(fd, null);

    const bufferId = `${this.name}/io-${fd}`;
    const br = this.config.bufferManager;

    try {
      await br.touch(bufferId, {});
    } catch (error) {
      this.fdMap.delete(fd);
      throw error;
    }

    try {
      this.fdMap.set(fd, {
        handle: await br.open(bufferId, {}, 'a+'),
        id: bufferId,
        jobs: jobScope.getStore(),
      });
    } catch (error) {
      this.fdMap.delete(fd);
      throw error;
    }

    return fd;
  }

  /** Close the write end of a pipe, so its reader sees EOF. */
  async pipeClose(fd: string): Promise<void> {
    const handle = this.pipeToHandle(fd);
    await handle.writeEOF();
  }

  /** Close the read end of a pipe: a write to it from here on throws a `BrokenPipeError`. */
  async pipeCloseRead(fd: string): Promise<void> {
    const entry = this.fdMap.get(fd);
    if (entry) {
      await this.config.bufferManager.closeRead(entry.id);
    }
  }

  /** Delete a pipe and its buffer. */
  async pipeRemove(fd: string): Promise<void> {
    const entry = this.fdMap.get(fd);
    if (entry) {
      await this.config.bufferManager.delete(entry.id);
    }

    this.fdMap.delete(fd);
  }

  /** Read a pipe to its end. */
  async pipeRead(fd: string, opts: PipeReadOptions = {}): Promise<string> {
    const handle = this.pipeToHandle(fd);

    try {
      if (!opts.signal && !opts.captureBudget) {
        return await toText(handle.readable);
      }

      const decoder = new TextDecoder();
      let output = '';

      try {
        while (true) {
          const chunk = await handle.read(64 * 1024, opts.signal);
          if (chunk.length === 0) break;
          opts.captureBudget?.consume(chunk.byteLength);
          output += decoder.decode(chunk, { stream: true });
        }
      } catch (error) {
        // The deadline, a hang-up or the output cap fired mid-read. What was
        // drained so far is the captured command's only account of itself, so
        // it is returned rather than thrown away with the abort; the executor
        // appends the reason.
        if (!opts.signal?.aborted) throw error;
      }

      return output + decoder.decode();
    } finally {
      if (opts.signal?.aborted) {
        await handle.writeEOF().catch(() => {});
      }
      await handle.close();
    }
  }

  /** Write text to a pipe. */
  async pipeWrite(fd: string, data: string): Promise<void> {
    // After close() the shell's own fds are gone. A command still unwinding —
    // e.g. a step that was mid-flight when the shell was force-closed on a stop
    // timeout — has nowhere for its output to go, so it is dropped.
    //
    // The test is whether the fd is gone, not whether it is one of a detached
    // job's two log fds: a detached job keeps opening pipes of its own after the
    // shell has closed — one per `$( )`, one per pipeline stage — and a builtin
    // writes to those through here. See ein/core#227.
    if (this.closed && !this.fdMap.get(fd)) {
      return;
    }
    const handle = this.pipeToHandle(fd);
    const buffer = this.encoder.encode(data);

    await handle.write(buffer);
  }

  /** Open an existing VFS path as a file descriptor. */
  async fdOpen(ctx: ExecContextIf, path: string, mode: string, fd?: string): Promise<string> {
    await this.assertNotRefusedGuest();
    fd = fd ?? this.getFreeFdNumber();
    const abspath = resolve(ctx.getCwd(), path);

    const handle = await this.config.vfs.open(this.accessIn(ctx), abspath, {
      mode: mode as 'r' | 'r+' | 'w+' | 'a+',
    });

    this.fdMap.set(fd, { handle, id: abspath, jobs: jobScope.getStore() });

    return fd;
  }

  /** Close a file descriptor's handle and forget it; the node stays. */
  async fdClose(fd: string): Promise<void> {
    const entry = this.fdMap.get(fd);
    if (entry) {
      await entry.handle.close();
      this.fdMap.delete(fd);
      this.fdReadBuffers.delete(fd);
    }
  }

  /** Read one line (up to delimiter) from a file descriptor, keeping the handle open. */
  async pipeReadLine(fd: string, delimiter = '\n'): Promise<string | null> {
    return (await this.pipeReadRecord(fd, delimiter))?.text ?? null;
  }

  /**
   * A line, and whether its delimiter ended it rather than the end of the input: `read` fails on
   * such a last line. Reads with the handle's signal, so a blocking resource (e.g. a queue) waits
   * for data instead of answering EOF while empty.
   */
  async pipeReadRecord(fd: string, delimiter = '\n'): Promise<{ text: string; delimited: boolean } | null> {
    const entry = this.fdMap.get(fd);
    if (!entry) return null;

    let buffer = this.fdReadBuffers.get(fd) || '';

    while (true) {
      const idx = buffer.indexOf(delimiter);
      if (idx !== -1) {
        this.fdReadBuffers.set(fd, buffer.substring(idx + delimiter.length));
        return { text: buffer.substring(0, idx), delimited: true };
      }

      const chunk = await entry.handle.read(4096, entry.handle.signal);
      if (chunk.length === 0) {
        this.fdReadBuffers.delete(fd);
        return buffer.length > 0 ? { text: buffer, delimited: false } : null;
      }

      buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  private getFreeFdNumber(): string {
    let fd = 3;
    while (this.fdMap.has(fd.toString())) {
      fd++;
    }

    return fd.toString();
  }
}
