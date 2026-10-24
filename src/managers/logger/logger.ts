import type { RouterManagerIf } from '../router/mod.ts';
import { loadConfig } from './config.ts';
import type { LogConfig, Logger, LogLevel } from './types.ts';

let routerManager: RouterManagerIf | null = null;

export function connectLoggerToRouter(rm: RouterManagerIf): void {
  routerManager = rm;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m', // gray
  INFO: '\x1b[36m', // cyan
  WARN: '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

let globalConfig: LogConfig | null = null;
const loggers = new Map<string, LoggerImpl>();

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** Writes an `Error` as `Name: message`, followed by its causes. */
function describeError(err: Error): string {
  const cause = err.cause;
  if (cause === undefined) return String(err);
  return `${err} (cause: ${cause instanceof Error ? describeError(cause) : String(cause)})`;
}

/**
 * `JSON.stringify` replacer for log context. An `Error`'s own properties are not enumerable, so it
 * would otherwise be written as `{}`.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? describeError(value) : value;
}

export function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';

  const parts = args.map((arg) => {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, errorReplacer);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  });

  return ' ' + parts.join(' ');
}

class LoggerImpl implements Logger {
  constructor(
    private name: string,
    private config: LogConfig,
  ) {}

  private getEffectiveLevel(): LogLevel {
    return this.config.modules[this.name] ?? this.config.level;
  }

  private isLevelEnabled(level: LogLevel): boolean {
    const effectiveLevel = this.getEffectiveLevel();
    return LEVEL_VALUES[level] >= LEVEL_VALUES[effectiveLevel];
  }

  private log(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.isLevelEnabled(level)) return;

    const timestamp = formatTimestamp();
    const levelPadded = level.padEnd(5);
    const color = LEVEL_COLORS[level];
    const argsStr = formatArgs(args);

    const formattedMessage = `[${timestamp}] ${color}[${levelPadded}]${RESET} [${this.name}] ${message}${argsStr}`;

    switch (level) {
      case 'DEBUG':
        console.debug(formattedMessage);
        break;
      case 'INFO':
        console.info(formattedMessage);
        break;
      case 'WARN':
        console.warn(formattedMessage);
        break;
      case 'ERROR':
        console.error(formattedMessage);
        break;
    }

    routerManager?.publish('system.logs', { level, name: this.name, message, timestamp });
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('DEBUG', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('INFO', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('WARN', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('ERROR', message, args);
  }
}

/**
 * Reads the log configuration from the environment. `createLogger` does the same on first use
 * when this has not been called.
 */
export function initializeLogger(): void {
  globalConfig = loadConfig();
}

/**
 * Returns the logger named `name` (e.g. 'pipe', 'shell-executor'), one instance per name. Its
 * level is the `LOG_MODULES` entry for that name, else `LOG_LEVEL`.
 */
export function createLogger(name: string): Logger {
  if (!globalConfig) {
    globalConfig = loadConfig();
  }

  if (loggers.has(name)) {
    return loggers.get(name)!;
  }

  const logger = new LoggerImpl(name, globalConfig);
  loggers.set(name, logger);
  return logger;
}
