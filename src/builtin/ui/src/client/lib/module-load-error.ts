/**
 * A module route whose code could not be had — the manifest unreadable, or the bundle replaced by
 * a deploy under an open page — rather than one that failed once drawn: reloading the page is
 * what helps, and the shell's error page says so (`RouteProblem`). Thrown by a module route's
 * `lazy` (`signals/module-ui.ts`).
 */
export class ModuleLoadError extends Error {
  constructor(readonly module: string, cause: unknown) {
    super(`${module}'s page could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
