import type { ManagerIf } from '../types.ts';
import { SystemCore } from '../../system-core.ts';
import { Signal } from './signal.ts';
import { CmdFunction, CmdOpts, CmdSpec, CmdState } from './types.ts';

export type ExecutionManagerConfig = SystemCore;

export type SignalOpts = {
  /** Include background (forground=false) commands, not just the foreground one. */
  includeBackground?: boolean;
  /** Skip commands that have been detached (e.g. SIGHUP on shell close). */
  skipDetached?: boolean;
};

export interface ExecutionManager extends ManagerIf {
  list(): CmdSpec[];

  get(name: string): CmdSpec | undefined;

  exec(name: string, opts: CmdOpts): Promise<CmdState>;

  execDynamic(fn: CmdFunction, opts: CmdOpts): Promise<CmdState>;

  /** Fire a command, returning its pid immediately plus a promise for its final state. */
  spawn(name: string, opts: CmdOpts): Promise<{ id: string; done: Promise<CmdState> }>;

  spawnDynamic(fn: CmdFunction, opts: CmdOpts): Promise<{ id: string; done: Promise<CmdState> }>;

  /** Wait for a specific command's final state. */
  wait(id: string): Promise<CmdState>;

  /** Flip a running command's foreground flag (fg/bg). */
  setForeground(id: string, forground: boolean): void;

  /**
   * Deliver a signal to a single command by pid; without one, only look. False
   * when no command by that pid is running.
   */
  signalPid(id: string, signal?: Signal): Promise<boolean>;

  /** Mark a running command detached so it survives SIGHUP on shell close. */
  detach(id: string): boolean;

  /** Deliver a signal to matching commands on a TTY. */
  signal(tty: string, signal: Signal, opts?: SignalOpts): Promise<void>;

  /**
   * Deliver a signal to every running command acting as `uid` — foreground,
   * background and detached alike, on any TTY — or with `elevated`, only to
   * those it started as an elevated sign-in (`user-elevate`). Returns how many
   * it reached.
   */
  signalUid(uid: number, signal: Signal, opts?: { elevated?: boolean }): Promise<number>;

  /** SIGINT to the foreground command(s) on a TTY. */
  interrupt(tty: string): Promise<void>;

  /** Resolve once no command on this TTY is still running, or the timeout elapses. */
  waitForTty(tty: string, timeoutMs: number): Promise<void>;

  resize(tty: string, rows: number, cols: number): Promise<void>;

  states(): CmdState[];
}
