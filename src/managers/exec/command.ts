import { Access } from '../../lib/access/types.ts';
import { ResourceHandleIf } from '../../registries/types.ts';
import { EchoMode } from '../shell/readline/mod.ts';
import { SystemCore } from '../../system-core.ts';
import { ExecutionManager } from './mod.ts';
import { Signal } from './signal.ts';
import type { Input } from './command-input.ts';
import { CmdOpts } from './types.ts';

export type CommandSystemCore = SystemCore & {
  cem: ExecutionManager;
};

export type { VfsCommand } from '../../lib/vfs-command.ts';

export interface Command {
  readonly sys: CommandSystemCore;

  readonly opts: CmdOpts;
  readonly env: Record<string, string>;
  /** The tty's `launchEnv`: where a setting no one at the shell may change is read. */
  readonly launchEnv: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly id: string;
  readonly parentId?: string;
  readonly access: Access;
  readonly name: string;
  readonly tty: boolean;
  readonly json: boolean;
  readonly args: string[];
  readonly stdinId: string;
  readonly stdout: ResourceHandleIf;
  readonly stderr: ResourceHandleIf;
  readonly interrupted: boolean;
  /** Aborted by a terminating signal, for cancelling what the command waits on. */
  readonly interruptSignal: AbortSignal;
  readonly signal: Signal | undefined;
  readonly detached: boolean;
  readonly forground: boolean;
  readonly rows: number;
  readonly cols: number;

  /** Stdin, read as bytes, lines or text; `openStdin` is the handle, for raw use. */
  readonly stdin: Input;
  openStdin(): Promise<ResourceHandleIf>;

  init(): Promise<void>;
  dispose(): Promise<void>;

  kill(signal: Signal): Promise<void>;
  onSignal(handler: ((signal: Signal) => void) | null): void;
  onInterrupt(handler: (() => void) | null): void;
  setDetached(detached: boolean): void;

  onResize(handler: ((rows: number, cols: number) => void) | null): void;
  resize(rows: number, cols: number): Promise<void>;

  setForground(forground: boolean): Promise<void>;

  /**
   * Ask on the terminal and read the answer. A command with no terminal (no `tty`) is not asked: it
   * fails at once with `<name>: no terminal to answer on; <instead>`, `instead` saying how to give
   * the answer without one (`add --force`).
   */
  prompt(prompt?: string, echoMode?: EchoMode, instead?: string): Promise<string>;
  write(data: string): Promise<void>;
  writeLn(data: string): Promise<void>;
  writeJSON(data: any, pretty?: boolean): Promise<void>;
  writeYAML(data: any): Promise<void>;
  writeError(data: string): Promise<void>;
  clearScreen(): Promise<void>;

  /** Run a script and capture its output; past `timeoutMs` it is stopped, with `timedOut` set. */
  execute(script: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
  executeInline(script: string): Promise<number>;
  login(username: string, password: string, session?: boolean): Promise<void>;
  logout(session?: boolean): Promise<void>;
  /** Act as a share link's principal from now on, in this shell and with `session` in its session. */
  actAsLink(access: Access, session?: boolean): Promise<void>;
  /** Make this shell's sign-in an administrator's, and with `session` its session's (`user-elevate`). */
  elevate(password: string, session?: boolean): Promise<void>;
  /** Make this shell's sign-in, and with `session` its session's, no longer an administrator's. */
  unelevate(session?: boolean): Promise<void>;

  /**
   * Raw mode passes every input byte through unchanged, for editors and the like. Cooked mode,
   * the default, intercepts control characters such as Ctrl+C.
   */
  setRawMode(raw: boolean): void;
}
