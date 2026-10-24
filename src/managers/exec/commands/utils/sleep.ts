import type { Command } from '../../command.ts';
import { isTerminatingSignal } from '../../signal.ts';
import type { CmdReturn } from '../../types.ts';

export const sleep = async (cmd: Command): CmdReturn => {
  if (cmd.args.length < 1) {
    await cmd.writeError('sleep: missing operand\n');
    return 1;
  }

  const duration = Number.parseFloat(cmd.args[0]);

  if (Number.isNaN(duration) || duration < 0) {
    await cmd.writeError(`sleep: invalid time interval '${cmd.args[0]}'\n`);
    return 1;
  }

  // Woken by the signal rather than polling for it: a service's idle loop is
  // `sleep 3600`, and every `service stop` and harness teardown waits on it.
  const woken = Promise.withResolvers<void>();
  cmd.onSignal(async (signal) => {
    if (!isTerminatingSignal(signal)) {
      return;
    }
    try {
      // What the default handler prints when no handler is registered.
      if (signal === 'SIGINT' && cmd.forground) {
        await cmd.writeError('^C\n');
      }
    } finally {
      woken.resolve();
    }
  });

  try {
    // Delivered before the handler was in place.
    if (cmd.interrupted) {
      return 130; // Standard exit code for SIGINT
    }
    const timer = setTimeout(woken.resolve, duration * 1000);
    try {
      await woken.promise;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    cmd.onSignal(null);
  }

  if (cmd.interrupted) {
    return 130;
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  }
  return 0;
};

sleep.spec = {
  name: 'sleep',
  effect: 'read' as const,
  description: 'Delay for a specified amount of time',
  args: [
    {
      name: 'seconds',
      type: 'string' as const,
      description: 'number of seconds to sleep',
    },
  ],
  flags: [],
};
