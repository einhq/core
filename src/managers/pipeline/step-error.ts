/**
 * How a step's output is condensed: a failed step's for its `error` attr and its log line, a
 * completed step's for its `output` attr.
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

/** Characters kept from the end of a completed step's output for its `output` attr. */
export const STEP_OUTPUT_TAIL = 400;

/**
 * The `output` attr for a step that exited zero: the end of what it wrote, where a command that
 * ends by saying what it did says it. Undefined when it wrote nothing.
 */
export function stepOutputTail(stdout: string): string | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  return text.length <= STEP_OUTPUT_TAIL ? text : `… ${text.slice(-STEP_OUTPUT_TAIL)}`;
}

/** Characters kept of a refusal's reason (`refusalReason`). */
export const REFUSAL_REASON_MAX = 300;

/**
 * Why a step could not run yet, in one line for a status line: the last line of its error, where a
 * command says what its service answered, cut to `REFUSAL_REASON_MAX`.
 */
export function refusalReason(detail: string): string {
  const line = detail.split('\n').map((part) => part.trim()).filter(Boolean).at(-1) ?? detail.trim();
  return line.length <= REFUSAL_REASON_MAX ? line : `${line.slice(0, REFUSAL_REASON_MAX - 1)}…`;
}
