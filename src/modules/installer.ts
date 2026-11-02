/**
 * The module installs EiN runs, one at a time, in an admin shell of the installer's: an install goes
 * on to its end whatever becomes of the session that asked for it, and anyone may follow it or ask
 * how far it has got (`mod status`). The shell runs `mod install` with `MOD_INSTALL_JOB` naming
 * the install, which is how that command knows it is the one doing the work.
 */

import { ulid } from '@std/ulid';
import type { ModuleInstallJob, ModuleInstallResult } from '../lib/api/mod.ts';
import { shq } from '../lib/shell-quote/mod.ts';
import { createLogger } from '../managers/logger/mod.ts';
import type { Shell } from '../managers/shell/mod.ts';
import type { SystemCore } from '../system-core.ts';
import type { NodeVFS } from '../vfs/mod.ts';

const logger = createLogger('module-installer');

/** The variable naming the install a `mod install` does the work of. */
export const INSTALL_JOB_VAR = 'MOD_INSTALL_JOB';

/** The session of the installer's shell. */
const SESSION_PATH = '!/.session-mod-install';

/** How many of its lines an install keeps, for whoever follows it from its start. */
const KEPT_LINES = 1000;

/** How many of its last lines `mod status` gives. */
const STATUS_LINES = 20;

type Line = { text: string; error?: boolean };

/** One install: what it was asked, what it has said, how far it has got and what it came to. */
export class InstallJob {
  readonly id = ulid().toLowerCase();
  readonly startedAt = new Date();
  finishedAt?: Date;
  state: ModuleInstallJob['state'] = 'running';
  unpacking?: { module: string; files: number };
  result?: ModuleInstallResult;
  /** The lines kept; `dropped` is how many said before them are not. */
  private lines: Line[] = [];
  private dropped = 0;
  /** The part of a line each stream has said so far. */
  private partial = { out: '', err: '' };
  private waiting: (() => void)[] = [];

  constructor(readonly args: string[], readonly by: string) {}

  /** Output as its shell writes it, a chunk at a time. */
  output(text: string, error: boolean): void {
    const key = error ? 'err' : 'out';
    const parts = (this.partial[key] + text).split('\n');
    this.partial[key] = parts.pop()!;
    for (const part of parts) this.add({ text: part, ...(error ? { error } : {}) });
  }

  private add(line: Line): void {
    this.lines.push(line);
    if (this.lines.length > KEPT_LINES) {
      this.lines.shift();
      this.dropped++;
    }
    this.changed();
  }

  /** The module it is unpacking now and how many of its files are in place; nothing once it is unpacked. */
  progress(unpacking?: { module: string; files: number }): void {
    this.unpacking = unpacking;
    this.changed();
  }

  /** What the install came to: its answer, when it gave one, and how its command exited. */
  finish(code: number, result?: ModuleInstallResult): void {
    for (const [key, text] of Object.entries(this.partial)) if (text) this.add({ text, ...(key === 'err' ? { error: true } : {}) });
    this.partial = { out: '', err: '' };
    this.unpacking = undefined;
    this.result = result ?? { ok: false, installed: [], failed: this.lines.filter((line) => line.error).map((line) => line.text).slice(-1) };
    this.state = code === 0 && this.result.ok ? 'done' : 'failed';
    this.finishedAt = new Date();
    this.changed();
  }

  /** The lines from the `from`th said on, those still kept, and the number of the next. */
  linesFrom(from: number): { lines: Line[]; next: number } {
    return { lines: this.lines.slice(Math.max(0, from - this.dropped)), next: this.dropped + this.lines.length };
  }

  /** Settles when the install says something more, gets further or finishes, or `signal` aborts. */
  next(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'running' || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiting.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private changed(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  toJSON(): ModuleInstallJob {
    return {
      id: this.id,
      args: this.args,
      by: this.by,
      startedAt: this.startedAt.toISOString(),
      ...(this.finishedAt ? { finishedAt: this.finishedAt.toISOString() } : {}),
      state: this.state,
      ...(this.unpacking ? { unpacking: { ...this.unpacking } } : {}),
      lines: this.lines.slice(-STATUS_LINES),
      ...(this.result ? { result: this.result } : {}),
    };
  }
}

/**
 * Starts installs, one at a time, and keeps the running one or else the last. Its shell is made at
 * the first install, with that caller's environment, and serves every install after it: its
 * session is a node of the process's own root, which can be made once.
 */
class ModuleInstaller {
  /** The install running now, or else the last one. */
  job?: InstallJob;
  private shell?: Promise<Shell>;

  constructor(private readonly sys: SystemCore) {}

  /** The install running now, if any. */
  get running(): InstallJob | undefined {
    return this.job?.state === 'running' ? this.job : undefined;
  }

  /**
   * Start `mod install <args>` for `by`, with the caller's `env` when it is the first. Throws while
   * another install runs: the caller follows that one or says so.
   */
  start(args: string[], by: string, env: Record<string, string>): InstallJob {
    if (this.running) throw new Error(`an install is running already: mod install ${this.running.args.join(' ')}`);
    if (!this.sys.shellManager) throw new Error('no shells to install in');
    const job = new InstallJob(args, by);
    this.job = job;
    void this.run(job, env).catch((error) => {
      logger.error('module install failed', { error });
      if (job.state === 'running') {
        job.output(`mod install: ${error instanceof Error ? error.message : String(error)}\n`, true);
        job.finish(1);
      }
    });
    return job;
  }

  private async run(job: InstallJob, env: Record<string, string>): Promise<void> {
    this.shell ??= this.sys.shellManager!.createSystemShell(
      { sessionPath: SESSION_PATH, env },
      (text, error) => this.job?.output(text, error),
    );
    let code = 1;
    try {
      code = await (await this.shell).run(`${INSTALL_JOB_VAR}=${job.id} JSON_OUTPUT=0 mod install ${job.args.map(shq).join(' ')}`);
    } finally {
      if (job.state === 'running') job.finish(code, job.result);
      logger.info(`mod install ${job.args.join(' ')}: ${job.state}`);
    }
  }
}

const installers = new WeakMap<NodeVFS, ModuleInstaller>();

/** This EiN's installer: one per VFS, which every command's system core shares. */
export const installerOf = (sys: SystemCore): ModuleInstaller => {
  let installer = installers.get(sys.vfs);
  if (!installer) installers.set(sys.vfs, installer = new ModuleInstaller(sys));
  return installer;
};
