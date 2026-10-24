import type { PoolJobSelector, PoolJobState } from '../../../../registries/pool/mod.ts';

const JOB_STATES: PoolJobState[] = ['ready', 'claimed', 'done', 'failed', 'cancelled'];

/**
 * Parse a `k=v,k=v` capacity or requirement vector. Repeatable flags arrive as
 * an array, so `--capacity gpu=1 --capacity vramMb=16000` and
 * `--capacity gpu=1,vramMb=16000` mean the same thing.
 */
export function parseVector(value: string | string[] | undefined, what: string): Record<string, number> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const vector: Record<string, number> = {};

  for (const part of (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','))) {
    if (!part.trim()) continue;

    const eq = part.indexOf('=');

    if (eq < 0) {
      throw new Error(`invalid ${what} '${part}' (expected key=number)`);
    }

    const key = part.slice(0, eq).trim();
    const num = Number(part.slice(eq + 1).trim());

    if (!key || !Number.isFinite(num)) {
      throw new Error(`invalid ${what} '${part}' (expected key=number)`);
    }

    vector[key] = num;
  }

  return vector;
}

/** Flags to a job selector. Exactly one of the four forms must be given. */
export function parseSelector(flags: { job?: string; key?: string; prefix?: string; kind?: string }): PoolJobSelector {
  const given = [flags.job, flags.key, flags.prefix, flags.kind].filter((v) => v !== undefined);

  if (given.length !== 1) {
    throw new Error('give exactly one of --job, --key, --prefix or --kind');
  }

  if (flags.kind !== undefined) {
    if (!flags.kind) throw new Error('--kind must name a kind');
    return { kind: flags.kind };
  }

  if (flags.job !== undefined) {
    const jobId = Number(flags.job);

    if (!Number.isInteger(jobId)) {
      throw new Error(`invalid job id '${flags.job}'`);
    }

    return { jobId };
  }

  return flags.key !== undefined ? { dedupKey: flags.key } : { dedupKeyPrefix: flags.prefix! };
}

export function parseStates(value: string | undefined, what: string): PoolJobState[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const states = value.split(',').map((s) => s.trim()).filter(Boolean) as PoolJobState[];

  for (const state of states) {
    if (!JOB_STATES.includes(state)) {
      throw new Error(`invalid ${what} '${state}' (expected ${JOB_STATES.join(', ')})`);
    }
  }

  return states;
}

/** `30s`, `5m`, `2h`, `7d`, or a bare number of milliseconds. */
export function parseDuration(value: string | undefined, what: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());

  if (!match) {
    throw new Error(`invalid ${what} '${value}' (expected e.g. 500ms, 30s, 5m, 2h, 7d)`);
  }

  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'ms']!;

  return Number(match[1]) * scale;
}
