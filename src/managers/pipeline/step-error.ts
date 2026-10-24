/**
 * How a failed step's output is condensed for its `error` attr and its log line.
 *
 * Both ends are kept. A step command that retries through several tools writes
 * the noisiest tool's output first and its own diagnosis last: the head shows
 * what the step was doing when it first went wrong, and the tail is where a
 * shell script's own verdict lives.
 */

/** Characters kept from the start of a failed step's output for the `error` attr. */
export const STEP_ERROR_HEAD = 1200;

/** Characters kept from its end, where the last tool's diagnosis is. */
export const STEP_ERROR_TAIL = 800;

/**
 * Narrower window for the log line, which duplicates the attr rather than
 * replacing it — enough that a container log names the cause without a person
 * having to go and read the step node first.
 */
export const STEP_LOG_HEAD = 400;

/** As `STEP_LOG_HEAD`, for the tail. */
export const STEP_LOG_TAIL = 400;

/** Keep `head` characters, then `tail`, marking what was dropped in between. */
export function elide(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${dropped} characters elided …\n${text.slice(-tail)}`;
}

/**
 * The output a failed step should be judged by: stderr wins over stdout, as
 * tools put diagnostics there, and a step that failed silently is described by
 * its exit code rather than by an empty string.
 */
function stepOutput(code: number, stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || `exit ${code}`;
}

/** The `error` attr for a step that exited non-zero. */
export function stepErrorDetail(code: number, stdout: string, stderr: string): string {
  return elide(stepOutput(code, stdout, stderr), STEP_ERROR_HEAD, STEP_ERROR_TAIL);
}

/** The same output, cut to a size a structured log field can carry. */
export function stepErrorLogDetail(code: number, stdout: string, stderr: string): string {
  return elide(stepOutput(code, stdout, stderr), STEP_LOG_HEAD, STEP_LOG_TAIL);
}
