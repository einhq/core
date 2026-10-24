import { type ExecContextIf, VOLATILE_PARAMS } from '@ein/bash-executor';

/**
 * The shell's variables a command it starts sees in its environment, beside
 * the exported ones: every one with a name a variable can have, so a prefix
 * assignment (`JSON_OUTPUT=1 person --help`) reaches it. Not `$$`, `$?` or the
 * positional parameters, and not the ones that change on every read —
 * `BASHPID`, `LINENO`, `RANDOM`, which frozen into a command's environment, and
 * from there into a service's, would come back in every session it started.
 */
export function commandVariables(ctx: ExecContextIf): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ctx.getParams()).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !VOLATILE_PARAMS.has(name)),
  );
}
