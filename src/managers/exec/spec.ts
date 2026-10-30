/**
 * What a command says about itself: its arguments, flags, output mode and effect.
 *
 * Imports nothing, on purpose. These types are part of the module contract (`@ein/client`), and
 * everything a contract type imports ships with the contract.
 */

/** What tab completion offers for an argument. */
export type ArgCompleteType = 'string' | 'path' | 'user' | 'group' | 'command' | 'number' | 'subcommand';
export type FlagCompleteType = ArgCompleteType | 'bool';

export type CmdArgDef = {
  name: string;
  type: ArgCompleteType;
  description: string;
  /**
   * The argument repeats: everything from this position on is another one of it.
   *
   * Only meaningful on the last entry. Completion indexes `args` by positional
   * offset, so without this a command that accepts more operands than it
   * declares has nothing to complete them with.
   */
  variadic?: boolean;
  /** The call may leave this argument out. Without it, a tool schema makes the model give one. */
  optional?: boolean;
  /**
   * This argument makes the call a write: given at all (`true` — the value to set, the name to
   * create), or given one of these values (a subcommand: `album create`, not `album info`). See
   * `CmdSpec.effect`.
   */
  writes?: boolean | string[];
  /**
   * This argument and every word after it are a command the call runs (`xargs rm -f`), judged as
   * one. The call's own flags all come before it.
   */
  runs?: boolean;
};

export type CmdFlagDef = {
  name: string;
  /**
   * What the flag takes, and whether it takes anything at all.
   *
   * `bool` is a switch (`-l`, `--facets`); anything else is a flag that takes a value
   * (`--kind photo`, `--from 2019`). `toolSchema()` cannot tell a switch from a value-taking
   * flag without it, so the spec tests require one.
   */
  type?: FlagCompleteType;
  description: string;
  /**
   * The flag may be given more than once (`--subject person:a --subject person:b`). A tool schema offers it as a
   * list: as a single string a model can name only one, since a JSON object cannot repeat a key.
   */
  repeatable?: boolean;
  /** Given, this flag makes a reading command a write (`attrs -s`, `--delete`). See `CmdSpec.effect`. */
  writes?: boolean;
  /** Given, a writing command changes nothing and reports what it would do (`--dry-run`, `-n`). */
  dryRun?: boolean;
};

/**
 * A word of a command that reads an expression rather than flags (find's `-delete`, `-exec`),
 * and what it does to the call's effect wherever it stands among the arguments. See
 * `CmdSpec.effect`.
 */
export type CmdWordDef = {
  word: string;
  /** Given, this word makes the call a write. */
  writes?: boolean;
  /** The words after it, up to the first of these, are a command the call runs: judged as one. */
  runs?: string[];
};

/**
 * What running a command does to the system. `read` never changes anything; `write` changes
 * something on every run. A command that does both is `read`, with the flags or arguments that
 * make it a write marked `writes`.
 */
export type CmdEffect = 'read' | 'write';

export type CmdSpec = {
  name: string;
  description?: string;
  args?: CmdArgDef[];
  flags?: CmdFlagDef[];
  /** Expression words that change the effect, which a flag parse would not see. */
  words?: CmdWordDef[];
  group?: boolean;
  /**
   * Whether the command honours JSON output mode. Default true.
   *
   * The API shell runs everything with `JSON_OUTPUT=1`, but a text primitive
   * must keep emitting text or `x | grep foo` and `$(x)` break. Setting this
   * to false makes `cmd.json` false for the command, so no shared helper it
   * reaches (`writeYAML` writes JSON when `cmd.json`) puts structured output
   * into a pipe.
   */
  json?: boolean;
  /**
   * Whether the command is a long-running daemon that owns its own lifecycle.
   *
   * Group dispatchers (`pipeline`, `service`, …) refuse to route to one, so
   * `pipeline engine` cannot start a second engine in the caller's session
   * against the same queue. Daemons are started as services.
   */
  daemon?: boolean;
  /**
   * Only an administrator may run it. Anyone else is refused before it starts, `--help`
   * included, and its node on PATH is not executable for them, so completion, the command
   * reference and the assistant leave it out. A daemon is always one.
   */
  admin?: boolean;
  /**
   * Part of signing in: what the sign-in page and a share link's page run before anyone is
   * signed in. Where visitors are asked to sign in (`CFG_GUEST_BROWSING` off), the guest may
   * run only these; anything else refuses it before it starts.
   */
  guest?: boolean;
  /**
   * One or two real command lines, for a reader who has never run it.
   *
   * A description says what a command is for; an example is the only part of a spec that
   * shows what a call looks like, such as which words are positional. Written as the line
   * itself, with no shell prompt, so help and `toolSchema()` can both print it verbatim.
   */
  examples?: string[];
  /**
   * What the command answers with under `JSON_OUTPUT=1`, in a sentence.
   *
   * The caller has to know whether a call gives back rows, a count or nothing before deciding
   * to make it. Nothing else in the spec says so.
   */
  returns?: string;
  /**
   * Whether running it changes anything, so that a caller acting for someone — the chat assistant —
   * can run a read at once and show a write to the user first. Judged per line by `judgeLine`
   * (`effect.ts`), with the flags and arguments given. Absent is unknown, which is judged a write:
   * a command nobody classified is shown before it runs, never run on a guess.
   */
  effect?: CmdEffect;
};
