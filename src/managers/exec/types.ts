import { ExecContextIf, ShellIf } from '@ein/bash-executor';
import { Access, Attribution } from '../../lib/access/mod.ts';
import type { ShellOrigin } from '../../lib/api/system.ts';
import { JSONObject } from '../../types.ts';
import { NodePath } from '../../vfs/mod.ts';
import { Command } from './command.ts';
import { Signal } from './signal.ts';

type TerminalMode = 'raw' | 'cooked';

export type CaptureGuardErrorCode = 'OUTPUT_LIMIT_EXCEEDED' | 'EXEC_TIMEOUT';

/**
 * Guards for one `runAndCapture`. They are per call, not per shell: the capture
 * gets its own sub-context and its own abort signal, so a deadline reached here
 * stops the commands *this* call started and leaves everything else the shell is
 * running concurrently alone.
 */
export type RunAndCaptureOptions = {
  maxOutputBytes?: number;
  /**
   * Variables set (or, with `null`, unset) for this script only, in a subshell of the
   * given context: the API shell runs a change the user approved in the chat with
   * `JSON_OUTPUT` off, so what the card shows is what a person would read in a terminal.
   */
  env?: Record<string, string | null>;
  /**
   * Wall clock the captured script gets. On expiry the running command is sent
   * SIGTERM and the call returns with `errorCode: 'EXEC_TIMEOUT'` — unlike
   * racing the promise from outside, which leaves the command running.
   */
  timeoutMs?: number;
  /**
   * The caller hanging up: when it aborts, the running command is sent SIGTERM as on the
   * deadline, and the call returns whatever the script left when it stopped.
   */
  signal?: AbortSignal;
  /** Called as the script's output is drained, stdout or stderr: it is still saying something. */
  onOutput?: () => void;
  /**
   * What the script's writes are recorded as coming from besides the shell's account: every
   * command it runs, however deep, acts with this `sid` and `cause`. A pipeline step names its run
   * and the write that started it this way.
   */
  attribution?: Attribution;
};

export type RunAndCaptureResult = {
  code: number;
  stdout: string;
  stderr: string;
  errorCode?: CaptureGuardErrorCode;
};

/** A background job a shell detached. */
export type ShellJobInfo = {
  jobNum: number;
  pid: string;
  command: string;
  detached: boolean;
  state: 'running' | 'done';
};

/** The bash executor's shell, with what EiN's terminals add to it. */
export interface TtyIf extends ShellIf {
  readonly name: string;

  /** Where the shell's input comes from. */
  readonly origin: ShellOrigin;

  /**
   * The environment the tty was opened with — its server's, or the process's settings for a system
   * shell — which nothing run in it can change, unlike the shell's own (`export`).
   */
  readonly launchEnv: Readonly<Record<string, string>>;

  open(): Promise<void>;

  close(): Promise<void>;

  /**
   * Detach a background job so it survives shell close, redirecting output to
   * a log (`detach`, `nohup`): by job spec, job number or pid in the job table
   * of `ctx`, the current job when none is given.
   */
  disownJob(sel?: string, ctx?: ExecContextIf): Promise<ShellJobInfo | undefined>;

  run(script: string, ctx?: ExecContextIf): Promise<number>;

  runAndCapture(script: string, ctx?: ExecContextIf, opts?: RunAndCaptureOptions): Promise<RunAndCaptureResult>;

  resize(rows: number, cols: number): Promise<void>;

  getIO(): TtyIO;

  login(username: string, password: string, session?: boolean): Promise<void>;

  logout(session?: boolean): Promise<void>;

  /** Act as a share link's principal in this tty and, with `session`, in its session (`share-link open`). */
  actAsLink(access: Access, session?: boolean): Promise<void>;

  /** Make this tty's sign-in an administrator's and, with `session`, its session's (`user-elevate`). */
  elevate(password: string, session?: boolean): Promise<void>;

  /** Make this tty's sign-in, and with `session` its session's, no longer an administrator's (`user-elevate --off`). */
  unelevate(session?: boolean): Promise<void>;

  /**
   * In cooked mode, control characters like Ctrl+C are intercepted; in raw mode, all bytes pass
   * through unchanged.
   */
  setTerminalMode(mode: TerminalMode): void;
}

export type TtyIO = {
  stdin: NodePath;
  stdout: NodePath;
  stderr: NodePath;
};

export type CmdOpts = {
  parentId?: string;
  forground?: boolean;
  stdin: NodePath;
  stdout: NodePath;
  stderr: NodePath;
  rows?: number;
  cols?: number;
  cwd: NodePath;
  args: string[];
  /**
   * What the command runs, for `ps` and `top`, where its name and arguments do
   * not say: a background job's source text. Never read as an argument.
   */
  label?: string;
  access: Access;
  tty: TtyIf;
  ctx: ExecContextIf;
};

export type CmdState = {
  state: 'running' | 'exited';
  name: string;
  /**
   * Only set while the command is running. `opts` reaches the exec context and
   * its parent chain, the shell and the access record; a state kept a minute
   * past exit so `wait` can still answer has no use for any of it.
   */
  opts?: CmdOpts;
  id: string;
  startTime: number;
  exitTime?: number;
  exitCode?: number;
  exitReason?: string;
  exitSignal?: Signal;
  exitData?: JSONObject;
};

export type { ArgCompleteType, CmdArgDef, CmdEffect, CmdFlagDef, CmdSpec, CmdWordDef, FlagCompleteType } from './spec.ts';
import type { CmdSpec } from './spec.ts';

export type CmdReturn = Promise<number>;

export type CmdFunction = ((cmd: Command) => CmdReturn) & {
  spec: CmdSpec;
};
