// ============================================================================
// SHARED LOGGER - Works in both Main and Renderer processes
// ============================================================================
//
// This is a lightweight logger for use in shared code and renderer process.
// For main process code, prefer using src/main/services/logger.ts which has
// additional features like file logging and request context.
//

import { formatTimestamp } from './dateUtils.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerConfig {
  level: LogLevel;
  prefix?: string;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LOG_COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m',
};

// Default to 'info' in production, 'debug' in development
const DEFAULT_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

class SharedLogger {
  private config: LoggerConfig;
  private module: string;

  constructor(module: string, config?: Partial<LoggerConfig>) {
    this.module = module;
    this.config = {
      level: config?.level ?? DEFAULT_LEVEL,
      prefix: config?.prefix,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.config.level);
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = formatTimestamp();
    const prefix = this.config.prefix ? `[${this.config.prefix}] ` : '';
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.reset;

    return `${color}[${timestamp}] [${level.toUpperCase()}] [${this.module}]${reset} ${prefix}${message}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.shouldLog('debug')) return;
    console.debug(this.formatMessage('debug', message), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (!this.shouldLog('info')) return;
    console.info(this.formatMessage('info', message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (!this.shouldLog('warn')) return;
    console.warn(this.formatMessage('warn', message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (!this.shouldLog('error')) return;
    console.error(this.formatMessage('error', message), ...args);
  }

  /**
   * Create a child logger with a sub-module name
   */
  child(subModule: string): SharedLogger {
    return new SharedLogger(`${this.module}:${subModule}`, this.config);
  }

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }
}

/**
 * Create a logger instance for a specific module
 */
export function createLogger(module: string, config?: Partial<LoggerConfig>): SharedLogger {
  return new SharedLogger(module, config);
}

// Default logger instance for quick access
const logger = new SharedLogger('App');

export default logger;
