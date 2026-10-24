import { resolve } from '@std/path';
import { parseArgs } from '../../../lib/args/mod.ts';
import { startHttpServer } from '../../../servers/http/http-server.ts';
import type { Command } from '../command.ts';
import { CmdReturn } from '../types.ts';

export const httpServer = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['port'],
  });
  const flagsPath = flags._[0] as string;
  const port = Number.parseInt(flags.port || '8080', 10);
  const ac = new AbortController();

  if (!flagsPath) {
    await cmd.writeError('http-server: missing path\n');
    return 1;
  }

  cmd.onInterrupt(() => ac.abort());

  await startHttpServer({
    port,
    signal: ac.signal,
    ...cmd.sys,
    rootPath: resolve(cmd.cwd, flagsPath),
    env: { ...cmd.env },
  });

  return 0;
};

httpServer.spec = {
  name: 'http-server',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Start an HTTP server',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to serve as root, "default" in root will be used as the default host',
    },
  ],
  flags: [
    {
      name: 'port',
      type: 'string' as const,
      description: 'port to use',
    },
  ],
};
