/**
 * One input of a command, as the command reads it: its stdin, or a node a FILE operand names.
 *
 * Imports nothing, on purpose. `Input` is part of the module contract (`@ein/client`), and
 * everything a contract type imports ships with the contract.
 */

/** One input. Each read goes on where the one before it stopped. */
export interface Input {
  /** The operand that names it: a path as given, or `-` for stdin. */
  readonly name: string;
  /** The bytes, as they arrive. */
  chunks(): AsyncGenerator<Uint8Array>;
  /**
   * The lines, as they arrive, each without its newline unless `keepNewline`. A last line without
   * a newline is a line too.
   */
  lines(opts?: { keepNewline?: boolean }): AsyncGenerator<string>;
  /** The text to its end, or as much of it as came before a terminating signal. */
  text(): Promise<string>;
}
