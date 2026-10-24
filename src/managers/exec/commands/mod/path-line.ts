/**
 * The bashrc PATH line for a module's bin/ directory. Guarded with `case` so
 * re-sourcing bashrc onto an already-populated inherited PATH (child shells,
 * pipeline engine) does not append duplicates.
 */
export const buildPathExportLine = (binPath: string): string =>
  // The pattern is unquoted on purpose: the shell's case matcher treats quotes in
  // patterns literally (module bin paths contain no glob chars or spaces).
  `case ":$PATH:" in *:${binPath}:*) ;; *) export PATH="$PATH:${binPath}";; esac`;
