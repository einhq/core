/**
 * Exit codes a bin that runs as a pipeline step uses to say what kind of failure it had.
 *
 * Any other non-zero exit is a failure of the step itself: it spends one of the step's attempts,
 * and once they are spent the instance fails. Two failures are not the step's, and treating them
 * like one either burned the attempts in seconds or retried what can never work:
 *
 * - `STEP_EXIT_TEMPORARY` — a service the step needs could not do it *now* (EMS busy, loading a
 *   model, restarting, unreachable). The pool hands the job back without counting the attempt and
 *   its kind is tried again after a pause; nothing is failed, however long the service takes to come back. A
 *   step the engine runs itself, outside a pool, waits the same way (`notBefore` on the step).
 * - `STEP_EXIT_INPUT` — the input itself is the problem (bytes no decoder can open). The step fails
 *   at once with `cause: 'input'`, never retried: every retry would meet the same bytes.
 *
 * The values are sysexits.h's EX_TEMPFAIL and EX_DATAERR.
 */
export const STEP_EXIT_TEMPORARY = 75;
export const STEP_EXIT_INPUT = 65;
