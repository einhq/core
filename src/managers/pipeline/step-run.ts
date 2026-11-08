import { ADMIN_ACCESS, type Attribution } from '../../lib/access/mod.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { RunAndCaptureResult, TtyIf } from '../exec/mod.ts';
import type { PipelineStepAttrs } from './types.ts';

/**
 * Grace a hung-up step gets to die before it is abandoned after all.
 *
 * Tools act on SIGTERM well inside this. One that ignores it would otherwise keep a stopping
 * worker from ever finishing its stop, so abandoning it is the fallback.
 */
const STEP_KILL_GRACE_MS = 30_000;

/** Exit code reported for a step abandoned after a hang-up; SIGTERM's convention. */
export const STEP_HUNG_UP_CODE = 143;

/** How often a running step's `outputAt` and `progress` are brought up to date while it runs. */
const OUTPUT_MARK_MS = 60_000;

type StepRunResult = { code: number; stdout: string; stderr: string };

/**
 * Run a pipeline step command to its end, however long that takes.
 *
 * No clock stops a step: a long one is working, and its result is what the pipeline is for
 * (ein/core#358). How long a step has gone without writing anything is reported instead,
 * through `onOutput`, and the pipeline overview flags a step that has been quiet for long.
 * `onProgress` is given what the command says of how much it has done (`Command.progress`).
 *
 * `signal` is the caller hanging up — a worker stopping, or losing the job's lease. The command
 * is sent SIGTERM through `runAndCapture`, which stops every command that capture started and
 * nothing else the shell runs, and a step that ignores it is abandoned after `graceMs`.
 *
 * `attribution` is what every write the command makes is recorded as coming from: the step's run
 * and the write that set it off (`stepAttribution`).
 */
export async function runStep(
  tty: TtyIf,
  command: string,
  opts: {
    signal?: AbortSignal;
    graceMs?: number;
    onOutput?: () => void;
    onProgress?: (fraction: number) => void;
    attribution?: Attribution;
    /** Variables the step's command runs with, beside the shell's. */
    env?: Record<string, string>;
  } = {},
): Promise<StepRunResult> {
  const { signal, graceMs = STEP_KILL_GRACE_MS, onOutput, onProgress, attribution, env } = opts;
  let timer: number | undefined;
  let onHangUp: (() => void) | undefined;

  // Only reached if SIGTERM did not settle the command. Leaking a process still beats a worker
  // that never stops.
  const abandon = new Promise<RunAndCaptureResult>((resolve) => {
    onHangUp = () => {
      timer = setTimeout(
        () => resolve({ code: STEP_HUNG_UP_CODE, stdout: '', stderr: `step was hung up, ignored SIGTERM for ${graceMs}ms, and was abandoned` }),
        graceMs,
      ) as unknown as number;
    };
    if (signal?.aborted) onHangUp();
    else signal?.addEventListener('abort', onHangUp, { once: true });
  });

  try {
    const result = await Promise.race([tty.runAndCapture(command, undefined, { signal, onOutput, onProgress, attribution, ...(env ? { env } : {}) }), abandon]);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onHangUp) signal?.removeEventListener('abort', onHangUp);
  }
}

/**
 * Keep a running step's `outputAt` within `everyMs` of the last byte it wrote, and its `progress`
 * within `everyMs` of the last fraction it reported, so the overview can tell a slow step that is
 * still working from one that has gone quiet, and say how far it has come. Write failures are
 * dropped: the marks are a report, and the next tick tries again.
 *
 * Returns `onOutput` and `onProgress` for `runStep`, and `stop`, which ends the ticks.
 */
export function markOutput(
  vfs: NodeVFS,
  stepPath: string,
  everyMs = OUTPUT_MARK_MS,
): { onOutput: () => void; onProgress: (fraction: number) => void; stop: () => void } {
  let last = 0;
  let marked = 0;
  let progress: { fraction: number; at: number } | undefined;
  let progressMarked = 0;
  const timer = setInterval(async () => {
    const attrs: Partial<PipelineStepAttrs> = {};
    if (last > marked) {
      attrs.outputAt = marked = last;
    }
    if (progress && progress.at > progressMarked) {
      attrs.progress = progress.fraction;
      attrs.progressAt = progressMarked = progress.at;
    }
    if (Object.keys(attrs).length === 0) return;
    try {
      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs });
    } catch {
      // A report, not state: the next tick writes a newer mark.
    }
  }, everyMs);
  return {
    onOutput: () => {
      last = Date.now();
    },
    onProgress: (fraction) => {
      if (progress?.fraction === fraction) return;
      progress = { fraction, at: Date.now() };
    },
    stop: () => clearInterval(timer),
  };
}
