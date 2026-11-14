import type { ConfigScope, ConfigSource } from '../config/types.ts';

/** One setting `config set` or `config unset` wrote: the value in force now, empty for a key, and where it comes from. */
export type ConfigWritten = { key: string; value: string; scope: ConfigScope; source: ConfigSource };

/**
 * `config set` and `config unset`: each setting written, the services restarted once for all of
 * them, those that failed to restart, and what takes effect later than the command returns (the
 * options' `restartNote`s). `ok` is false when a restart failed: the values are written, but that
 * service still runs on the old ones.
 */
export type ConfigWriteAnswer = {
  ok: boolean;
  settings: ConfigWritten[];
  restarted: string[];
  failed: { name: string; error: string }[];
  notes: string[];
};
