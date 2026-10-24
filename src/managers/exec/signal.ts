/**
 * Signals delivered to running commands.
 *
 * - SIGINT:  interrupt (Ctrl-C) — foreground only
 * - SIGTERM: polite termination (service/explicit stop, system shutdown)
 * - SIGHUP:  the controlling shell went away (tab/socket closed); detached
 *            commands ignore this one
 * - SIGKILL: the execution manager ends the command itself — it is reaped and
 *            its streams closed whether or not its function ever returns.
 *            For a command stuck in an await no signal can reach; see
 *            `ExecutionManager.signalPid`.
 * - SIGPIPE: the command wrote to a pipe nothing reads any more; the command
 *            delivers it to itself, and ends with 141 whatever it returns
 * - SIGTSTP: stop request (Ctrl-Z) — cooperative, best-effort
 * - SIGCONT: resume request — cooperative, best-effort
 */
export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGKILL' | 'SIGPIPE' | 'SIGTSTP' | 'SIGCONT';

/** Signals whose default disposition is to end the command. */
const TERMINATING_SIGNALS: ReadonlySet<Signal> = new Set<Signal>(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGPIPE']);

/** The exit code of a command that was killed: 128 + the signal number, as in bash. */
export const SIGKILL_EXIT_CODE = 137;

const SIGNAL_NUMBERS: Record<Signal, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15, SIGCONT: 18, SIGTSTP: 20 };

/** The status of a command a signal ended: 128 + its number, as in bash. */
export const signalExitCode = (sig: Signal): number => 128 + SIGNAL_NUMBERS[sig];

export const isTerminatingSignal = (sig: Signal): boolean => TERMINATING_SIGNALS.has(sig);
