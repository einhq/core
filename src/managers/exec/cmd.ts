import * as YAML from '@std/yaml';
import { BrokenPipeError } from '@ein/bash-executor';
import { type Access, GUEST_ACCESS } from '../../lib/access/mod.ts';
import { Disposables } from '../../lib/disposables/mod.ts';
import { createLogger } from '../logger/mod.ts';
import { ResourceHandleIf } from '../../registries/types.ts';
import { EchoMode, Readline } from '../shell/readline/mod.ts';
import { highlighter } from '../shell/terminal/mod.ts';
import { SystemCore } from '../../system-core.ts';
import { Command, CommandSystemCore } from './command.ts';
import { ExecutionManager } from './execution-manager.ts';
import type { Input } from './command-input.ts';
import { stdinInput } from './input.ts';
import { isTerminatingSignal, Signal } from './signal.ts';
import { CmdOpts, CmdSpec } from './types.ts';

const logger = createLogger('cmd');

/**
 * A prompt where no one can answer: the command has no terminal. The execution manager reports
 * it as the command's own error, so a script gets a refusal instead of waiting on stdin for good.
 */
export class NoTerminalError extends Error {
  constructor(instead?: string) {
    super(`no terminal to answer on${instead ? `; ${instead}` : ''}`);
  }
}

export class Cmd implements Command {
  private diposables = new Disposables();
  private encoder = new TextEncoder();

  public readonly sys: CommandSystemCore;

  protected _opts: CmdOpts;
  protected _stdout: ResourceHandleIf | undefined;
  protected _stderr: ResourceHandleIf | undefined;
  protected _stdin: ResourceHandleIf | undefined;
  private _stdinInput: Input | undefined;
  protected _interrupted = false;
  /**
   * Aborted by a terminating signal: hangs up the scripts this command started with `execute`,
   * and cancels a read of its input.
   */
  private hangUp = new AbortController();
  protected _signal: Signal | undefined;
  /** Set by SIGKILL: the command is over, whatever its function goes on to do. */
  protected _killed = false;
  protected _detached = false;
  protected _rows: number;
  protected _cols: number;
  protected _id: string;
  protected _name: string;
  protected _forground: boolean;
  protected _env: Record<string, string>;
  protected _spec: CmdSpec | undefined;
  protected onSignalHandler: ((signal: Signal) => void) | undefined;
  protected onResizeHandler: ((rows: number, cols: number) => void) | undefined;

  constructor(sys: SystemCore, cem: ExecutionManager, id: string, name: string, env: Record<string, string>, opts: CmdOpts, spec?: CmdSpec) {
    this.sys = {
      ...sys,
      cem,
    };
    this._id = id;
    this._name = name;
    this._opts = opts;
    this._spec = spec;
    this._env = env;
    this._forground = opts.forground ?? true;
    this._rows = opts.rows || 24;
    this._cols = opts.cols || 80;
  }

  public async init() {
    this._stdout = await this.sys.bufferManager.open(this._opts.stdout, {}, 'w');
    this.diposables.addDisposable(async () => {
      await this._stdout?.close();
    });

    this._stderr = await this.sys.bufferManager.open(this._opts.stderr, {}, 'w');
    this.diposables.addDisposable(async () => {
      await this._stderr?.close();
    });
  }

  public async dispose() {
    await this.diposables.dispose();
  }

  /**
   * Deliver a signal to the command. Terminating signals flip the `interrupted`
   * flag (which cooperative commands poll) and hang up what the command is running
   * through `execute`; a registered handler is invoked with the signal so bridged
   * commands can react per-cause.
   */
  public async kill(signal: Signal) {
    this._signal = signal;
    if (signal === 'SIGKILL') {
      this._killed = true;
    }
    if (isTerminatingSignal(signal)) {
      this._interrupted = true;
      this.hangUp.abort();
    }
    if (this.onSignalHandler) {
      Promise.resolve(this.onSignalHandler(signal)).catch((error) => logger.error('signal handler error', error));
    } else if (this._forground && signal === 'SIGINT') {
      await this.writeError('^C\n');
    }
  }

  public onSignal(handler: ((signal: Signal) => void) | null) {
    this.onSignalHandler = handler ? handler : undefined;
  }

  /**
   * Set a handler that fires only for terminating signals. Set on a command that is already
   * interrupted, it fires at once: a command stopped while it was still setting up has the
   * stop delivered when it starts listening.
   */
  public onInterrupt(handler: (() => void) | null) {
    this.onSignalHandler = handler ? ((signal) => isTerminatingSignal(signal) && handler()) : undefined;
    if (handler && this._interrupted) handler();
  }

  public setDetached(detached: boolean) {
    this._detached = detached;
  }

  public onResize(handler: ((rows: number, cols: number) => void) | null) {
    this.onResizeHandler = handler ? handler : undefined;
  }

  public async resize(rows: number, cols: number) {
    this._rows = rows;
    this._cols = cols;

    if (this.onResizeHandler) {
      await this.onResizeHandler(rows, cols);
    }
  }

  public async setForground(forground: boolean) {
    this._forground = forground;
  }

  get cwd() {
    return this._opts.cwd;
  }

  get id() {
    return this._id;
  }

  get parentId() {
    return this._opts.parentId;
  }

  /**
   * The access the command acts with: the guest's once SIGKILL ended it, so a
   * function orphaned in an await cannot go on acting as its account when the
   * await settles.
   */
  get access() {
    return this._killed ? GUEST_ACCESS : this._opts.access;
  }

  get opts() {
    return this._opts;
  }

  get name() {
    return this._name;
  }

  get interrupted() {
    return this._interrupted;
  }

  get signal() {
    return this._signal;
  }

  get detached() {
    return this._detached;
  }

  get forground() {
    return this._forground;
  }

  get rows() {
    return this._rows;
  }

  get cols() {
    return this._cols;
  }

  get tty() {
    return this._env.TERM === '1';
  }

  get launchEnv() {
    return this._opts.tty.launchEnv;
  }

  get json() {
    // `spec.json: false` opts a text primitive out entirely — the API shell sets
    // JSON_OUTPUT=1 for every command, and `seq | grep` has to keep working.
    return this._env.JSON_OUTPUT === '1' && this._spec?.json !== false;
  }

  get args() {
    return this._opts.args;
  }

  get env() {
    return this._env;
  }

  get stdout() {
    return this._stdout!;
  }

  get stderr() {
    return this._stderr!;
  }

  get stdinId() {
    return this._opts.stdin;
  }

  get stdin(): Input {
    return this._stdinInput ??= stdinInput(this);
  }

  get interruptSignal() {
    return this.hangUp.signal;
  }

  public async openStdin() {
    if (this._stdin) {
      return this._stdin;
    }

    this._stdin = await this.sys.bufferManager.open(this._opts.stdin, {}, 'r');
    this.diposables.addDisposable(async () => {
      await this.closeStdin();
    });

    return this._stdin;
  }

  protected async closeStdin() {
    if (this._stdin) {
      await this._stdin?.close();
      this._stdin = undefined;
    }
  }

  async write(data: string) {
    if (data && this._stdout) {
      await this.writeTo(this._stdout, data);
    }
  }

  /** Write to one of the command's outputs. One nothing reads any more sends it SIGPIPE, as in bash. */
  private async writeTo(handle: ResourceHandleIf, data: string) {
    try {
      await handle.write(this.encoder.encode(data));
    } catch (error) {
      if (error instanceof BrokenPipeError) {
        await this.kill('SIGPIPE');
      }
      throw error;
    }
  }

  async writeLn(data: string) {
    return await this.write(`${data}\n`);
  }

  async writeJSON(data: any, pretty: boolean = true) {
    if (this.json || !pretty) {
      return await this.writeLn(JSON.stringify(data));
    }

    const highlight = highlighter(!this.tty);
    return await this.writeLn(highlight(JSON.stringify(data, null, 4), 'json'));
  }

  async writeYAML(data: any) {
    if (this.json) {
      return await this.writeLn(JSON.stringify(data));
    }

    const highlight = highlighter(!this.tty);
    return await this.write(highlight(YAML.stringify(data, { skipInvalid: true, sortKeys: true, lineWidth: this.cols }), 'yaml'));
  }

  async writeError(data: string) {
    if (data && this._stderr) {
      await this.writeTo(this._stderr, data);
    }
  }

  async prompt(prompt?: string, echoMode?: EchoMode, instead?: string) {
    // Without a terminal stdin may be a channel that stays open with no one behind it, such as an
    // ssh exec's, and a read would wait on it for good.
    if (!this.tty) throw new NoTerminalError(instead);
    try {
      const rl = new Readline({
        in: await this.openStdin(),
        out: this._stdout!,
        rows: this.rows,
        cols: this.cols,
        echoMode,
      });

      return await rl.prompt(prompt);
    } catch (error) {
      if ((error as Error).message === 'EOF') {
        await this.writeError('\nexit\n');
        throw error;
      } else if ((error as Error).message === 'Interrupted') {
        throw error;
      } else if ((error as Error).message.startsWith('Unclosed')) {
        return '\n';
      } else {
        throw error;
      }
    } finally {
      await this.closeStdin();
    }
  }

  async clearScreen() {
    await this.write('\x1b[2J\x1b[0;0H');
  }

  async execute(script: string, opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    const { code, stdout, stderr, errorCode } = await this._opts.tty.runAndCapture(script, this.opts.ctx, { signal: this.hangUp.signal, timeoutMs: opts.timeoutMs });
    return { code, stdout, stderr, ...(errorCode === 'EXEC_TIMEOUT' ? { timedOut: true } : {}) };
  }

  async executeInline(script: string): Promise<number> {
    return this._opts.tty.run(script, this.opts.ctx);
  }

  async login(username: string, password: string, session?: boolean): Promise<void> {
    return this._opts.tty.login(username, password, session);
  }

  async logout(session?: boolean): Promise<void> {
    return this._opts.tty.logout(session);
  }

  async actAsLink(access: Access, session?: boolean): Promise<void> {
    return this._opts.tty.actAsLink(access, session);
  }

  async elevate(password: string, session?: boolean): Promise<void> {
    return this._opts.tty.elevate(password, session);
  }

  async unelevate(session?: boolean): Promise<void> {
    return this._opts.tty.unelevate(session);
  }

  setRawMode(raw: boolean): void {
    this._opts.tty.setTerminalMode(raw ? 'raw' : 'cooked');
  }
}
