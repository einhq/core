/**
 * Progress markers for a bin that runs as a pipeline step.
 *
 * A step is never stopped for taking long; what it writes is how a person tells
 * a slow step from a stuck one. While it runs, any output keeps it off the
 * pipeline overview's list of quiet steps, and when it fails, what it wrote is
 * the step's error. A bin that stays silent until it is done gives neither.
 *
 * So the phases go to stderr with their offset from the start, one short line
 * each. Only when captured (no terminal) or asked for: a person running the
 * bin by hand at a terminal sees the bin's own output, not its diary.
 */

type Writer = { readonly tty: boolean; writeError(data: string): Promise<void> };

export type StepPhase = (label: string) => Promise<void>;

/** A `phase('…')` that writes `<name>: +<ms>ms <label>` when it should, else nothing. */
export const stepPhase = (cmd: Writer, name: string, verbose = false): StepPhase => {
  if (cmd.tty && !verbose) return async () => {};
  const started = Date.now();
  return async (label) => {
    await cmd.writeError(`${name}: +${Date.now() - started}ms ${label}\n`);
  };
};
