/**
 * `ssh`: a shell or one command on another machine.
 *
 * Interactive sessions put the terminal in raw mode and relay it byte for byte,
 * so the remote side draws everything (editors, `top`, completion). `~.` at
 * the start of a line disconnects, as in OpenSSH.
 */

import type { Channel, Client } from 'ssh2';
import { connectSsh, formatTarget, parseSshTarget, SshConnectError } from '../../../../lib/ssh/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { applySshOption, checkSshAllowed, connectOptions, hostSettings, parsePort, type SshConfigOptions, sshUserFromCommand } from './options.ts';

interface SshArgs {
  config: SshConfigOptions;
  /** -F: the config file instead of ~/.ssh/config */
  configFile?: string;
  host: string;
  command: string[];
  /** -t count: 1 asks for a pty when there is a terminal, 2 always */
  forceTty: number;
  noTty: boolean;
  quiet: boolean;
}

const VALUE_FLAGS = new Set(['p', 'i', 'l', 'o', 'F']);

/**
 * OpenSSH stops reading options at the host: everything after it is the remote
 * command, flags included (`ssh host ls -la`).
 */
function parseSshArgs(args: string[]): SshArgs {
  const config: SshConfigOptions = {};
  let configFile: string | undefined;
  let forceTty = 0;
  let noTty = false;
  let quiet = false;

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;

    // Bundled letters: -tt, -qT, -p22
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (VALUE_FLAGS.has(letter)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) throw new Error(`option requires an argument -- ${letter}`);
        if (letter === 'p') config.port = parsePort(value);
        else if (letter === 'i') config.identity = value;
        else if (letter === 'l') config.user = value;
        else if (letter === 'F') configFile = value;
        else applySshOption(config, value);
        break;
      }
      if (letter === 't') forceTty++;
      else if (letter === 'T') noTty = true;
      else if (letter === 'q') quiet = true;
      else throw new Error(`unknown option -- ${letter}`);
    }
  }

  const host = args[i];
  if (!host) throw new Error('missing host');
  return { config, configFile, host, command: args.slice(i + 1), forceTty, noTty, quiet };
}

/** Relay a readable into the command's stdout or stderr */
async function pump(from: ReadableStream<Uint8Array>, to: { write(data: Uint8Array): Promise<number | void> }) {
  try {
    for await (const chunk of from) await to.write(chunk);
  } catch {
    // The channel or the terminal went away; the session is ending anyway
  }
}

/**
 * Relay the terminal into the channel until `stop` settles. `escapes` turns on
 * OpenSSH's `~.` (disconnect) at the start of a line, and `~~` for a literal `~`.
 */
async function relayStdin(
  cmd: Command,
  channel: Channel,
  stop: Promise<unknown>,
  opts: { escapes: boolean; onDisconnect: () => void },
): Promise<void> {
  const stdin = await cmd.openStdin();
  const reader = stdin.readable.getReader();
  const writer = channel.writable.getWriter();
  let atLineStart = true;
  let pendingTilde = false;

  const stopped = stop.then(() => ({ done: true, value: undefined } as const));

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      if (!opts.escapes) {
        await writer.write(value);
        continue;
      }

      const out: number[] = [];
      for (const byte of value) {
        if (pendingTilde) {
          pendingTilde = false;
          if (byte === 0x2e /* . */) {
            opts.onDisconnect();
            return;
          }
          if (byte !== 0x7e /* ~ */) out.push(0x7e);
          out.push(byte);
          atLineStart = false;
          continue;
        }
        if (atLineStart && byte === 0x7e) {
          pendingTilde = true;
          continue;
        }
        out.push(byte);
        atLineStart = byte === 0x0d || byte === 0x0a;
      }
      if (out.length) await writer.write(new Uint8Array(out));
    }

    // End of our input: tell the remote side, as OpenSSH does for a pipe
    await writer.close().catch(() => {});
  } catch {
    // The channel closed under us
  } finally {
    writer.releaseLock();
    reader.releaseLock();
    await stdin.close().catch(() => {});
  }
}

export const ssh = async (cmd: Command): CmdReturn => {
  let args: SshArgs;
  try {
    args = parseSshArgs(cmd.args);
  } catch (error) {
    await cmd.writeError(`ssh: ${(error as Error).message}\nusage: ssh [-qTt] [-F configfile] [-i identity] [-l user] [-o option] [-p port] [user@]host [command ...]\n`);
    return 255;
  }

  if (!await checkSshAllowed(cmd, 'ssh')) return 255;

  let target;
  try {
    target = parseSshTarget(args.host);
  } catch (error) {
    await cmd.writeError(`ssh: ${(error as Error).message}\n`);
    return 255;
  }

  let config: SshConfigOptions;
  try {
    config = await hostSettings(cmd, target.host, { ...args.config, user: target.user ?? args.config.user }, args.configFile);
  } catch (error) {
    await cmd.writeError(`ssh: ${(error as Error).message}\n`);
    return 255;
  }

  const remoteCommand = args.command.join(' ');
  const wantPty = args.forceTty >= 2 || (!args.noTty && cmd.tty && (remoteCommand === '' || args.forceTty > 0));
  if (!remoteCommand && !cmd.tty && !args.noTty && !args.quiet) {
    await cmd.writeError('Pseudo-terminal will not be allocated because stdin is not a terminal.\n');
  }

  const abort = new AbortController();
  cmd.onInterrupt(() => abort.abort());

  let client: Client;
  try {
    client = await connectSsh(sshUserFromCommand(cmd), connectOptions(target.host, config, abort.signal));
  } catch (error) {
    cmd.onInterrupt(null);
    if (abort.signal.aborted) return 130;
    const message = error instanceof SshConnectError ? error.message : String(error);
    await cmd.writeError(`ssh: ${message}\n`);
    return 255;
  }

  let channel: Channel;
  try {
    const pty = wantPty ? { rows: cmd.rows, cols: cmd.cols, term: 'xterm-256color' } : undefined;
    channel = remoteCommand ? await client.exec(remoteCommand, { pty }) : await client.shell({ pty: pty ?? false });
  } catch (error) {
    client.end();
    cmd.onInterrupt(null);
    await cmd.writeError(`ssh: ${(error as Error).message}\n`);
    return 255;
  }

  let exitCode: number | undefined;
  let disconnected = false;
  channel.on('exit-status', (code: number) => exitCode = code);
  channel.on('exit-signal', () => exitCode ??= 255);
  const closed = new Promise<void>((done) => channel.on('close', () => done()));

  const disconnect = () => {
    disconnected = true;
    channel.close();
    client.end();
  };

  const raw = wantPty && cmd.tty;
  if (raw) {
    cmd.setRawMode(true);
    cmd.onResize((rows, cols) => channel.setWindow(rows, cols, 0, 0));
  }
  // In raw mode Ctrl-C reaches the remote side as a byte; an interrupt that
  // still arrives (a kill from elsewhere) is passed on, then ends the session
  let interrupted = false;
  cmd.onInterrupt(() => {
    interrupted = true;
    try {
      channel.signal('INT');
    } catch {
      // not open any more
    }
    disconnect();
  });

  try {
    if (!await channel.accepted) {
      await cmd.writeError(`ssh: ${remoteCommand ? 'exec' : 'shell'} request failed on channel\n`);
      return 255;
    }

    await Promise.all([
      pump(channel.readable, cmd.stdout),
      // Client side, stderr is the remote command's extended data: a readable
      pump(channel.stderr as ReadableStream<Uint8Array>, cmd.stderr),
      relayStdin(cmd, channel, closed, { escapes: raw, onDisconnect: disconnect }),
      closed,
    ]);
  } finally {
    if (raw) {
      cmd.setRawMode(false);
      cmd.onResize(null);
    }
    cmd.onInterrupt(null);
    client.end();
  }

  if (interrupted) return 130;
  if (disconnected) {
    if (!args.quiet) await cmd.writeError(`\r\nConnection to ${formatTarget(target)} closed.\r\n`);
    return exitCode ?? 255;
  }
  if (!remoteCommand && !args.quiet && raw) {
    await cmd.writeError(`Connection to ${target.host} closed.\r\n`);
  }
  return exitCode ?? 255;
};

ssh.spec = {
  name: 'ssh',
  // Runs whatever it is given on another machine: judged a write
  effect: 'write' as const,
  json: false,
  description: 'Log in to another machine or run a command there (members of group ssh)',
  args: [
    { name: 'destination', type: 'string' as const, description: '[user@]host, or a Host from ~/.ssh/config' },
    { name: 'command', type: 'string' as const, variadic: true, description: 'command to run there instead of a shell' },
  ],
  flags: [
    { name: 'p', type: 'number' as const, description: 'port (default 22)' },
    { name: 'l', type: 'string' as const, description: 'remote user (default: your EiN user)' },
    { name: 'i', type: 'path' as const, description: 'identity file (default: ~/.ssh/id_ed25519, id_ecdsa, id_rsa)' },
    { name: 'F', type: 'path' as const, description: 'config file (default ~/.ssh/config; none: no file)' },
    {
      name: 'o',
      type: 'string' as const,
      repeatable: true,
      description:
        'HostName, Port, User, IdentityFile, StrictHostKeyChecking, BatchMode, ConnectTimeout, ServerAliveInterval, PasswordAuthentication; the same keywords are read from ~/.ssh/config',
    },
    { name: 't', type: 'bool' as const, repeatable: true, description: 'allocate a terminal for a command (-tt: even without one here)' },
    { name: 'T', type: 'bool' as const, description: 'never allocate a terminal' },
    { name: 'q', type: 'bool' as const, description: 'quiet' },
  ],
  examples: [
    'ssh anna@nas.local',
    'ssh -p 2222 backup.example.com',
    "ssh nas.local 'df -h'",
    'ssh -o StrictHostKeyChecking=accept-new anna@nas.local uptime',
  ],
  returns: 'the remote exit status; 255 when the connection fails.',
};
