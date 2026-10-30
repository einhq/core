import { ulid } from '@std/ulid';
import { ADMIN_ACCESS, isAdmin, isGuest, verifyAccess } from '../../lib/access/mod.ts';
import { guestMayBrowse } from '../../lib/config/mod.ts';
import { Deferred, deferred } from '../../lib/async/mod.ts';
import { JSONObject } from '../../types.ts';
import { NodeType } from '../../vfs/mod.ts';
import { NODE_TYPE_COMMAND } from '../../vfs/types/command.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { commandVariables } from '../shell/variables.ts';
import { Cmd, NoTerminalError } from './cmd.ts';
import { Command } from './command.ts';
import { COMMAND_NAMES } from './commands/mod.ts';
import { ExecutionManager, ExecutionManagerConfig, SignalOpts } from './execution-manager.ts';
import { SIGKILL_EXIT_CODE, Signal, signalExitCode } from './signal.ts';
import { CmdFunction, CmdOpts, CmdSpec, CmdState } from './types.ts';

const EXECUTABLE_NODE_TYPES: NodeType[] = [
  NODE_TYPE_COMMAND,
  NODE_TYPE_FILE,
];

export class ExecManager implements ExecutionManager {
  private commands: CmdFunction[] = [];
  private cmdStates = new Set<CmdState>();
  private pending: Record<string, Deferred<CmdState>> = {};
  private running: Record<string, Command> = {};
  /** Per running command: end it from the outside, for SIGKILL. */
  private killers: Record<string, () => Promise<CmdState>> = {};

  constructor(private config: ExecutionManagerConfig) {
    this.commands = [...COMMAND_NAMES];
  }

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    await Promise.all(Object.values(this.running).map((cmd) => cmd.kill('SIGTERM')));
  }

  private getCommand(name: string) {
    const cmd = this.commands.find((c) => c.spec.name === name);

    if (!cmd) {
      throw new Error(`no such command: ${name}`);
    }

    return cmd;
  }

  public async exec(name: string, opts: CmdOpts): Promise<CmdState> {
    const { done } = await this._spawn(this.getCommand(name), name, opts);
    return done;
  }

  public async execDynamic(fn: CmdFunction, opts: CmdOpts): Promise<CmdState> {
    const { done } = await this._spawn(fn, fn.spec.name, opts);
    return done;
  }

  /** Fire a command and return its pid immediately, plus a promise for its final state. */
  public async spawn(name: string, opts: CmdOpts): Promise<{ id: string; done: Promise<CmdState> }> {
    return this._spawn(this.getCommand(name), name, opts);
  }

  public async spawnDynamic(fn: CmdFunction, opts: CmdOpts): Promise<{ id: string; done: Promise<CmdState> }> {
    return this._spawn(fn, fn.spec.name, opts);
  }

  private async _spawn(cmd: CmdFunction, name: string, opts: CmdOpts): Promise<{ id: string; done: Promise<CmdState> }> {
    const id = `${name}-${ulid()}`;
    const env: Record<string, string> = {
      ...opts.ctx.getEnv(),
      ...commandVariables(opts.ctx),
      PID: id,
    };

    const command = new Cmd(this.config, this, id, name, env, opts, cmd.spec);

    const state: CmdState = {
      state: 'running',
      id: command.id,
      name: command.name,
      opts,
      startTime: Date.now(),
    };

    this.running[command.id] = command;
    this.pending[command.id] = deferred();

    // Once: SIGKILL finishes the command from the outside, and its own return
    // — if it ever comes — must not finish it a second time.
    let finished: Promise<CmdState> | undefined;
    const finish = (exitCode: number, exitReason?: string, exitData?: JSONObject): Promise<CmdState> => {
      return finished ??= finishOnce(exitCode, exitReason, exitData);
    };

    const finishOnce = async (exitCode: number, exitReason?: string, exitData?: JSONObject) => {
      delete this.killers[command.id];
      await command.dispose();
      delete this.running[command.id];

      // Drop the 'running' entry. `finishState` below is a copy; the original
      // holds `opts`, which reaches the exec context, its env and its streams,
      // and would otherwise stay in the set for the life of the process.
      this.cmdStates.delete(state);

      const finishState: CmdState = {
        ...state,
        // Not `opts`: the exited copy outlives the command by the retention
        // window below, and `opts` reaches the exec context, its parent chain,
        // the shell and the access record. `wait` and the job commands read
        // only the exit code and the timing off a finished state.
        opts: undefined,
        state: 'exited',
        exitReason,
        exitSignal: command.signal,
        exitTime: Date.now(),
        exitCode,
        exitData,
      };

      this.cmdStates.add(finishState);

      if (finishState.id in this.pending) {
        const resolve = this.pending[finishState.id].resolve;
        delete this.pending[finishState.id];
        resolve(finishState);
      }

      setTimeout(() => {
        this.cmdStates.delete(finishState);
      }, 1000 * 60);

      return finishState;
    };

    try {
      await command.init();
      this.cmdStates.add(state);
    } catch (e) {
      return { id, done: finish(255, e instanceof Error ? e.message : 'unknown error') };
    }

    this.killers[command.id] = () => finish(SIGKILL_EXIT_CODE, 'killed');

    // Here rather than in each command, so that no way of starting one — a name, a path, a group
    // dispatcher, a module's `#!ts` bin — skips it. 126 is bash's "found but not executable".
    if (cmd.spec.admin && !isAdmin(opts.access)) {
      await command.writeError(`${name}: permission denied: only an administrator may run it\n`);
      return { id, done: finish(126) };
    }

    // Where visitors are asked to sign in, the guest gets what signing in takes and nothing else.
    if (!cmd.spec.guest && isGuest(opts.access) && !await guestMayBrowse(command.sys.vfs)) {
      await command.writeError(`${name}: sign in first\n`);
      return { id, done: finish(126) };
    }

    // A help flag shows help instead of running the command. Asked in JSON, it answers with
    // the `CmdSpec` itself, which `tool-schema.ts` turns into an agent's tool.
    //
    // `JSON_OUTPUT` alone decides, not `command.json`: help describes the command rather than
    // being its output, so a text primitive's `spec.json: false` does not apply to it.
    if (this.hasHelpFlag(opts.args)) {
      const wantsJson = command.env.JSON_OUTPUT === '1';
      await command.write(wantsJson ? JSON.stringify(cmd.spec) : await this.formatHelp(command, cmd.spec));
      return { id, done: finish(0) };
    }

    // SIGPIPE ends the command whatever it makes of the failed write, quietly
    cmd(command)
      .then((result) => {
        if (command.signal === 'SIGPIPE') {
          return finish(signalExitCode('SIGPIPE'));
        }

        if (Array.isArray(result)) {
          const [code, data] = result;
          return finish(code, undefined, data);
        }

        return finish(result);
      })
      .catch(async (e) => {
        if (command.signal === 'SIGPIPE') return finish(signalExitCode('SIGPIPE'));
        // A prompt with no terminal is the command refusing, in its own name, as any usage error.
        if (e instanceof NoTerminalError) {
          await command.writeError(`${name}: ${e.message}\n`).catch(() => {});
          return finish(1);
        }
        return finish(255, e.message);
      });

    return { id, done: this.pending[command.id] };
  }

  public async signal(tty: string, signal: Signal, opts: SignalOpts = {}) {
    const commands = Object.values(this.running).filter((cmd) => {
      if (cmd.env.TTY_NAME !== tty) return false;
      if (!opts.includeBackground && !cmd.forground) return false;
      if (opts.skipDetached && cmd.detached) return false;
      return true;
    });

    await Promise.all(commands.map((cmd) => this.deliver(cmd, signal)));
  }

  /**
   * Deliver a signal to one command.
   *
   * Every signal but SIGKILL is cooperative: the command is told and decides
   * what to do. SIGKILL is the manager's own: after the command has been told
   * (so a compound job can pass it on to its group), the manager ends it —
   * exit code 137, its output streams closed, its record reaped — whether or
   * not its function ever returns. That is what makes a job stuck in an await
   * no signal reaches, such as a read on a pipe nobody will close, go away.
   * The function itself is not unwound; a cooperative runtime cannot do that.
   * It is orphaned: it keeps whatever it holds until the await it is parked in
   * settles, which for a dead pipe is never.
   */
  private async deliver(cmd: Command, signal: Signal): Promise<void> {
    await cmd.kill(signal);
    if (signal === 'SIGKILL') {
      await this.killers[cmd.id]?.();
    }
  }

  public async signalUid(uid: number, signal: Signal, opts?: { elevated?: boolean }): Promise<number> {
    const commands = Object.values(this.running).filter((cmd) => cmd.access.uid === uid && (!opts?.elevated || cmd.access.elevated === true));
    await Promise.all(commands.map((cmd) => this.deliver(cmd, signal)));
    return commands.length;
  }

  public async interrupt(tty: string) {
    await this.signal(tty, 'SIGINT');
  }

  public async waitForTty(tty: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const active = Object.values(this.running).some((cmd) => cmd.env.TTY_NAME === tty);
      if (!active) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Wait for a specific command's final state (whether still running or recently exited). */
  public async wait(id: string): Promise<CmdState> {
    if (id in this.pending) {
      return this.pending[id];
    }
    const state = [...this.cmdStates].find((s) => s.id === id && s.state === 'exited');
    if (state) {
      return state;
    }
    throw new Error(`no such job: ${id}`);
  }

  public setForeground(id: string, forground: boolean): void {
    this.running[id]?.setForground(forground);
  }

  public async signalPid(id: string, signal?: Signal): Promise<boolean> {
    const cmd = this.running[id];
    if (!cmd) {
      return false;
    }
    if (signal) {
      await this.deliver(cmd, signal);
    }
    return true;
  }

  /** Mark a running command detached so it survives SIGHUP on shell close. */
  public detach(id: string): boolean {
    const cmd = this.running[id];
    if (!cmd) {
      return false;
    }
    cmd.setDetached(true);
    return true;
  }

  public async resize(tty: string, rows: number, cols: number) {
    const commands = Object.values(this.running).filter((cmd) => cmd.env.TTY_NAME === tty);

    await Promise.all(commands.map((cmd) => cmd.resize(rows, cols)));
  }

  public list() {
    return this.commands.map((c) => c.spec);
  }

  public get(name: string) {
    const cmd = this.commands.find((c) => c.spec.name === name);
    return cmd?.spec;
  }

  public states() {
    return Array.from(this.cmdStates);
  }

  private hasHelpFlag(args: string[]): boolean {
    return args[0] === '-h' || args[0] === '--help';
  }

  private async formatHelp(cmd: Command, opts: CmdSpec): Promise<string> {
    const lines: string[] = [];

    let usage = `Usage: ${opts.name}`;
    if (opts.flags?.length) {
      usage += ' [OPTIONS]';
    }
    if (opts.args?.length) {
      for (const arg of opts.args) {
        usage += ` <${arg.name}>`;
      }
    }
    lines.push(usage);
    lines.push('');

    if (opts.description) {
      lines.push(opts.description);
      lines.push('');
    }

    const args = [...(opts.args || [])];

    if (args.length > 0) {
      if (args[0].type === 'subcommand') {
        lines.push('Subcommands:');

        if (!cmd.env.PATH) {
          lines.push('    -');
        }

        const entries = (await Promise.all(
          [...new Set(cmd.env.PATH.split(':').filter(Boolean))].map(async (path) => {
            try {
              return await cmd.sys.vfs.children(ADMIN_ACCESS, path);
            } catch {
              return [];
            }
          }),
        )).flat();

        const names = entries
          .filter((e) => EXECUTABLE_NODE_TYPES.includes(e.node.type))
          .filter((e) => verifyAccess(cmd.access, e.node.props, 'x'))
          .map((e) => e.name)
          .filter((name) => name.startsWith(`${cmd.name}-`))
          .map((name) => name.replace(`${cmd.name}-`, ''))
          .filter((name) => !name.startsWith('_'));

        names.sort((a: string, b: string) => a.localeCompare(b));

        const maxLen = Math.max(...names.map((name) => name.length));
        for (const name of names) {
          const padded = `${name}`.padEnd(maxLen + 4);
          lines.push(`  ${padded}`);
        }
        lines.push('');

        args.splice(0, 1);
      }
    }

    if (args.length > 0) {
      lines.push('Arguments:');
      const maxLen = Math.max(...args.map((a) => a.name.length));
      for (const arg of args) {
        const padded = `<${arg.name}>`.padEnd(maxLen + 4);
        lines.push(`  ${padded}  ${arg.description}`);
      }
      lines.push('');
    }

    const hasOptions = (opts.flags?.length ?? 0) > 0;

    if (hasOptions) {
      lines.push('Options:');

      const options: { flag: string; desc: string }[] = [];

      for (const flag of (opts.flags ?? []).filter(({ type }) => !type)) {
        const isShort = flag.name.length === 1;
        const flagStr = isShort ? `-${flag.name}` : `--${flag.name}`;
        options.push({ flag: flagStr, desc: flag.description });
      }

      for (const flagArg of (opts.flags ?? []).filter(({ type }) => type)) {
        const isShort = flagArg.name.length === 1;
        const flagStr = isShort ? `-${flagArg.name} <${flagArg.type}>` : `--${flagArg.name} <${flagArg.type}>`;
        options.push({ flag: flagStr, desc: flagArg.description });
      }

      options.push({ flag: '-h, --help', desc: 'Show this help message' });

      const maxFlagLen = Math.max(...options.map((o) => o.flag.length));

      for (const opt of options) {
        const padded = opt.flag.padEnd(maxFlagLen);
        lines.push(`  ${padded}  ${opt.desc}`);
      }
      lines.push('');
    }

    // What comes back, and what a call looks like: an example shows which words are positional
    // and which flags go together.
    if (opts.returns) {
      lines.push('Returns:');
      lines.push(`  ${opts.returns}`);
      lines.push('');
    }
    if (opts.examples?.length) {
      lines.push('Examples:');
      for (const example of opts.examples) lines.push(`  ${example}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
