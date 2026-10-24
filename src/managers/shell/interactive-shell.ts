import { type History, LineEditor, type TabCompletion } from '@ein/bash-executor';
import { join } from '@std/path';
import { isAdmin } from '../../lib/access/mod.ts';
import { createLogger } from '../logger/mod.ts';
import { DEFAULT_COMPLETION } from './completion.ts';
import { Readline } from './readline/mod.ts';
import { Shell, ShellConfig } from './shell.ts';
import { color, defaultPS1, expandPS1 } from './terminal/mod.ts';

const logger = createLogger('shell');

/** How many Ctrl-Ds `set -o ignoreeof` refuses before letting the shell go, as in bash. */
const IGNORED_EOF_LIMIT = 10;

/**
 * An interactive shell, as bash is one: it reads what is typed a line at a
 * time, asks for more (PS2) while a command is unfinished, and keeps a history
 * with `!` expansion — the executor's, so `history`, `fc` and `!!` are bash's.
 * The executor reads it from HISTFILE, `~/.bash_history`, as the shell starts,
 * and each command is added to the end of the file as it is run.
 */
export class InteractiveShell extends Shell {
  /** HISTFILE as this shell made it, `~/.bash_history`, which a login changes with HOME. */
  private defaultHistoryFile?: string;
  /** The line editor, readline's keys over this shell's history; one for the session, for C-o and keys typed ahead */
  private editor?: LineEditor;

  private get lineEditor(): LineEditor {
    return this.editor ??= new LineEditor(() => this.ctx.getHistory?.());
  }

  constructor(config: ShellConfig) {
    super({
      ...config,
      env: {
        ...config.env,
        TERM: '1',
      },
    });
  }

  /** Write to stderr. Never throws: a client that has gone away has taken FD 2 with it. */
  private async writeError(data: string): Promise<void> {
    try {
      const handle = this.pipeToHandle('2');
      await handle.write(this.encoder.encode(data));
    } catch {
      // Nothing left to write to — the shell is on its way out regardless.
    }
  }

  private async write(data: string): Promise<void> {
    const handle = this.pipeToHandle('1');
    await handle.write(this.encoder.encode(data));
  }

  getPrompt(): string {
    const admin = this.access !== undefined && isAdmin(this.access);
    return expandPS1(this.ctx, this.ctx.getEnv().PS1 || defaultPS1(admin), admin);
  }

  override async open(): Promise<void> {
    await super.open();

    // An interactive shell: `$-` has `i`, and `cmd &` says its job number and pid
    this.ctx.setInteractive?.(true);
    // On in an interactive bash before its rc file runs, so .bashrc can turn them off
    this.ctx.setShellOption('history', true);
    this.ctx.setShellOption('histexpand', true);
    // Several sessions share one file: each adds its own lines rather than writing its list over the others'
    this.ctx.setShellOption('histappend', true);
    // A line typed with a leading space, or the same as the last, is not kept
    if (this.ctx.getParam('HISTCONTROL') === undefined) this.ctx.setParams({ HISTCONTROL: 'ignoreboth' });
    // Every command completes from its spec until .bashrc says otherwise with `complete`
    await this.run(DEFAULT_COMPLETION);

    const localRcFile = join(this.getEnv().HOME, '.bashrc');
    try {
      if (await this.config.vfs.exists(this.access!, localRcFile)) {
        await this.run(`source "${localRcFile}"`);
      }
    } catch {
      // A broken .bashrc does not stop the shell from opening.
    }

    await this.loadHistory();
  }

  /** The executor's history of this shell: an ExecContext always has one. */
  protected get commandHistory(): History {
    return this.ctx.getHistory!();
  }

  /** The commands kept, oldest first. */
  protected get historyLines(): string[] {
    return this.commandHistory.entries.map((entry) => entry.line);
  }

  /**
   * Read the history: the executor reads HISTFILE, cut to HISTFILESIZE first,
   * as bash does at the start. A login or logout is another user, whose own
   * `~/.bash_history` it then is, unless HISTFILE was set to another file.
   */
  protected async loadHistory() {
    const history = this.commandHistory;

    history.clear();
    history.linesThisSession = 0;

    if (this.defaultHistoryFile !== undefined && this.ctx.getParam('HISTFILE') === this.defaultHistoryFile) this.ctx.setParams({ HISTFILE: null });
    // A thousand entries unless HISTSIZE says otherwise, where bash keeps 500
    if (this.ctx.getParam('HISTSIZE') === undefined) this.ctx.setParams({ HISTSIZE: '1000' });

    try {
      await this.startHistory();
    } catch (error) {
      logger.debug('history not read', { error: (error as Error).message });
    }

    const file = this.ctx.getParam('HISTFILE');

    this.defaultHistoryFile = file === join(this.getEnv().HOME, '.bash_history') ? file : undefined;
  }

  override async login(
    username: string,
    password: string,
    session?: boolean,
  ): Promise<void> {
    await super.login(username, password, session);
    await this.loadHistory();
  }

  override async logout(session?: boolean): Promise<void> {
    await super.logout(session);
    await this.loadHistory();
  }

  /** An interactive shell has a prompt to print a finished job's line before. */
  protected override get queuesJobReports(): boolean {
    return true;
  }

  /**
   * Run an interactive shell session
   */
  async runInteractive(): Promise<number> {
    let buffer = '';

    // `set -o ignoreeof` does not make Ctrl-D inert for ever — bash takes the
    // tenth one, so a terminal that has genuinely gone quiet still lets go
    let refusedEofs = 0;

    while (!this.isClosed && !this.hasExited) {
      // A job that finished while the last command ran is announced before the
      // prompt, as in bash — unless `set -b` already said so at the time
      await this.flushJobReports();

      const ps1 = this.getPrompt();
      const ps2 = '> ';

      try {
        const rl = new Readline({
          in: this.pipeToHandle('0'),
          out: this.pipeToHandle('1'),
          editor: this.lineEditor,
          rows: this.rows,
          cols: this.cols,
          onTab: (line: string, point: number, list: boolean) => this.onTab(line, point, list),
        });

        // Set raw mode during readline - readline handles Ctrl+C itself
        this.setTerminalMode('raw');
        try {
          buffer += await rl.prompt(buffer.length === 0 ? ps1 : ps2);
        } finally {
          // Back to cooked mode for command execution - InputMonitor handles Ctrl+C
          this.setTerminalMode('cooked');
        }
      } catch (error) {
        // A disconnect can tear the shell down while we are parked in
        // rl.prompt(). Everything below assumes fds still exist, so bail out
        // before classifying the error.
        if (this.isClosed) {
          break;
        }

        // EOT is Ctrl-D on an empty line, which `ignoreeof` may decline to act
        // on. EOF is stdin going away, which it never may — the loop would spin
        // on a dead fd.
        const eof = (error as Error).message === 'EOT' || (error as Error).message === 'EOF';

        if ((error as Error).message === 'EOT' && this.ctx.getShellOption('ignoreeof') && refusedEofs < IGNORED_EOF_LIMIT) {
          refusedEofs++;
          await this.writeError('\nUse "exit" to leave the shell.\n');
          buffer = '';
          continue;
        }

        if (eof) {
          await this.writeError('\nexit\n');
          break;
        } else if ((error as Error).name === 'AbortError') {
          break;
        } else if ((error as Error).message === 'Interrupted') {
          await this.writeError('^C\n');
          buffer = '';
          continue;
        } else {
          // Without stdin the next iteration throws the exact same error from
          // pipeToHandle('0') with nothing consuming input in between — a tight
          // loop spamming the log forever. A vanished fd is teardown, not a
          // recoverable error, so leave instead of retrying.
          if (!this.hasPipe('0') || !this.hasPipe('1')) {
            logger.debug('interactive shell stdin gone, exiting loop', { name: this.name });
            break;
          }

          console.error('shell ', error);
          try {
            await this.writeError(`${color('red', 'error')}: ${(error as Error).message}\n`);
          } catch {
            break;
          }
        }

        buffer = '';
        continue;
      }

      // An open quote, `if` or here-document: PS2 asks for the next line
      if (buffer && await this.isUnfinished(buffer)) {
        buffer += '\n';
        continue;
      }

      if (buffer) {
        // Only *consecutive* Ctrl-Ds count towards the limit
        refusedEofs = 0;

        await this.runInput(buffer);
      }

      buffer = '';
    }

    return 0;
  }

  /**
   * A Tab, completed by the executor as bash's readline does: the
   * specification `complete` defined for the command — by default
   * `_ein_complete`, which asks `completion-arg` for the words the command's
   * spec allows, and `_ein_commands` for a command's name — else bash's own
   * completion. A completion that fails leaves the line as it was.
   */
  private async onTab(line: string, point: number, list: boolean): Promise<TabCompletion> {
    try {
      return await this.completeTab(line, point, list);
    } catch (err) {
      logger.error('tab completion failed', err);
      return { line, point, bell: true };
    }
  }

  /**
   * Run what was typed as the shell's input — expanded and kept in the
   * history line by line — then add what it kept to the end of HISTFILE, so a
   * session that is cut off keeps its history too.
   */
  protected async runInput(text: string): Promise<number> {
    try {
      return await this.run(text, undefined, { history: true });
    } finally {
      await this.appendHistory().catch(() => {});
    }
  }

  /** The history saved as bash saves it when a shell ends, the file cut to HISTFILESIZE. */
  override async close(): Promise<void> {
    if (!this.isClosed) await this.saveHistory().catch(() => {});

    await super.close();
  }
}
