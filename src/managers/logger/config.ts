import type { LogConfig, LogLevel } from './types.ts';

const VALID_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

function isValidLevel(level: string): level is LogLevel {
  return VALID_LEVELS.includes(level as LogLevel);
}

export function loadConfig(): LogConfig {
  const envLevel = Deno.env.get('LOG_LEVEL')?.toUpperCase() || 'INFO';
  const level: LogLevel = isValidLevel(envLevel) ? envLevel : 'INFO';

  // LOG_MODULES sets per-logger levels: "pipe:DEBUG,shell:INFO,streams:WARN".
  const modules: Record<string, LogLevel> = {};
  const envModules = Deno.env.get('LOG_MODULES');

  if (envModules) {
    for (const pair of envModules.split(',')) {
      const [moduleName, moduleLevel] = pair.split(':').map((s) => s.trim());
      if (moduleName && moduleLevel) {
        const upperLevel = moduleLevel.toUpperCase();
        if (isValidLevel(upperLevel)) {
          modules[moduleName] = upperLevel;
        }
      }
    }
  }

  return { level, modules };
}
