/**
 * The completion an interactive shell starts with, as bash configuration.
 *
 * The split is bash's: the generators (`completion-arg`, `completion-commands`
 * and the other `completion-*` commands) print one candidate per line and
 * know nothing about the line being edited; the executor does readline's
 * half of a Tab (`AstExecutor.completeTab`) — the one match or the prefix
 * all of them share into the line, quoted, a `/` or a space after it, and the
 * list on the next Tab.
 */

/**
 * The completion every command gets until a `complete` of its own replaces it:
 * bash's `-D` default, with a function that asks `completion-arg` — which
 * reads the command's spec — for the words. `=` and `:` do not break words
 * here (they do in bash's COMP_WORDBREAKS), so `--flag=value` is one word to
 * the spec, as `completion-arg` expects. Paths are file names to readline —
 * quoted, listed by their last part — and a flag waiting for its value, or a
 * directory to go into, takes no space after it.
 *
 * A command's name comes from `-I`: the shell's aliases, builtins, functions
 * and keywords, and `completion-commands`'s names on PATH, which leave out a
 * group's subcommands (`pipeline-run` is reached as `pipeline run`). With no
 * match, `bashdefault` has bash complete it — a path to a command, a directory.
 *
 * Builtins have no spec, so the ones that take names rather than paths get
 * bash's own: variables, aliases, builtins, commands, shell options and jobs.
 * Any other builtin (`cd`, `source`) completes paths through `completion-arg`.
 */
export const DEFAULT_COMPLETION = `COMP_WORDBREAKS=\$' \\t\\n"\\'><;|&('
_ein_complete() {
  local - IFS=\$'\\n'
  set -f
  COMPREPLY=(\$(completion-arg "\${COMP_WORDS[@]:0:COMP_CWORD}" --word="\$2"))
  [[ \${COMPREPLY[*]} == */* ]] && compopt -o filenames
  [[ \${#COMPREPLY[@]} == 1 && \$COMPREPLY == *[=/] ]] && compopt -o nospace
  return 0
}
complete -D -F _ein_complete
_ein_commands() {
  local - IFS=\$'\\n'
  set -f
  COMPREPLY=(\$(compgen -A alias -A builtin -A function -A keyword -- "\$2"; completion-commands --word="\$2"))
}
complete -I -o bashdefault -F _ein_commands
complete -v export unset readonly declare local typeset
complete -a alias unalias
complete -b -k builtin enable help
complete -c type hash
complete -A shopt shopt
complete -j -P % fg jobs disown wait
complete -A stopped -P % bg`;
