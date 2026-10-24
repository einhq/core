import type { ModuleSetup } from '../lib/api/mod.ts';

/**
 * How each module's last `mod setup` in this process went.
 *
 * A module is installed when its directory is under `/usr/modules`, but it works only once setup
 * has put its bins on PATH, registered its settings and started its services — and `mod setup
 * --all` at boot carries on past a module that fails, so an installed module can sit there doing
 * nothing with only a log line to say so. In memory like the settings and contributions tables:
 * setup runs at every boot, and what it said last boot says nothing about this one.
 */
const byModule = new Map<string, ModuleSetup>();

/** Record a setup's outcome; `problems` empty means it completed. */
export const recordModuleSetup = (name: string, problems: string[]): void => {
  byModule.set(name, { ok: problems.length === 0, at: Date.now(), problems });
};

/** The last setup's outcome, or undefined when the module has not been set up in this process. */
export const moduleSetupOf = (name: string): ModuleSetup | undefined => byModule.get(name);

/** Forget a removed module. */
export const forgetModuleSetup = (name: string): void => {
  byModule.delete(name);
};
