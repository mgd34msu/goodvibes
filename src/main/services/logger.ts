// ============================================================================
// STRUCTURED LOGGER SERVICE
// ============================================================================

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getRequestContext } from './requestContext.js';
import { formatTimestamp, getTodayString } from '../../shared/dateUtils.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  requestId?: string;
  operation?: string;
  data?: unknown;
  metadata?: LogMetadata;
}

export interface LogMetadata {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  duration?: number;
  [key: string]: unknown;
}

interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  logDir: string;
  maxFileSize: number; // bytes
  maxFiles: number;
}

const LOG_COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m',
};

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Default configuration
const defaultConfig: LoggerConfig = {
  level: 'info',
  enableConsole: true,
  enableFile: process.env.NODE_ENV === 'production',
  logDir: '', // Set dynamically
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
};

export class Logger {
  private module: string;
  private static config: LoggerConfig = { ...defaultConfig };
  private static logStream: fs.WriteStream | null = null;
  private static currentLogFile: string = '';
  private static logBuffer: LogEntry[] = [];
  private static flushInterval: NodeJS.Timeout | null = null;

  constructor(module: string) {
    this.module = module;
  }

  static configure(options: Partial<LoggerConfig>): void {
    Logger.config = { ...Logger.config, ...options };

    if (Logger.config.enableFile && !Logger.logStream) {
      Logger.initFileLogging();
    }
  }

  static setLevel(level: LogLevel): void {
    Logger.config.level = level;
  }

  static getLevel(): LogLevel {
    return Logger.config.level;
  }

  private static initFileLogging(): void {
    try {
      // Get log directory
      const logDir = Logger.config.logDir || path.join(app.getPath('userData'), 'logs');

      // Create log directory if needed
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      // Create log file with date
      const date = getTodayString();
      Logger.currentLogFile = path.join(logDir, `goodvibes-${date}.log`);

      // Open write stream in append mode
      Logger.logStream = fs.createWriteStream(Logger.currentLogFile, { flags: 'a' });

      // Set up periodic flush
      Logger.flushInterval = setInterval(() => {
        Logger.flush();
      }, 5000);

      // Clean up old logs
      Logger.rotateOldLogs(logDir);
    } catch (error) {
      console.error('Failed to initialize file logging:', error);
    }
  }

  private static rotateOldLogs(logDir: string): void {
    try {
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith('goodvibes-') && f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(logDir, f), stat: fs.statSync(path.join(logDir, f)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

      // Remove old files beyond maxFiles
      while (files.length > Logger.config.maxFiles) {
        const oldFile = files.pop();
        if (oldFile) {
          fs.unlinkSync(oldFile.path);
        }
      }
    } catch (error) {
      console.error('Failed to rotate logs:', error);
    }
  }

  private static flush(): void {
    if (Logger.logBuffer.length === 0 || !Logger.logStream) return;

    const entries = Logger.logBuffer.splice(0, Logger.logBuffer.length);
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

    Logger.logStream.write(content);
  }

  static shutdown(): void {
    Logger.flush();

    if (Logger.flushInterval) {
      clearInterval(Logger.flushInterval);
      Logger.flushInterval = null;
    }

    if (Logger.logStream) {
      Logger.logStream.end();
      Logger.logStream = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(Logger.config.level);
  }

  private createEntry(level: LogLevel, message: string, data?: unknown, metadata?: LogMetadata): LogEntry {
    const context = getRequestContext();
    return {
      timestamp: formatTimestamp(),
      level,
      module: this.module,
      message,
      requestId: context?.requestId,
      operation: context?.operation,
      data,
      metadata,
    };
  }

  private formatConsoleMessage(entry: LogEntry): string {
    const color = LOG_COLORS[entry.level];
    const reset = LOG_COLORS.reset;

    // Include request ID in output if available (first 8 chars for brevity)
    const reqIdSuffix = entry.requestId ? ` [${entry.requestId.substring(0, 8)}]` : '';
    let output = `${color}[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.module}]${reqIdSuffix}${reset} ${entry.message}`;

    if (entry.metadata) {
      const metaStr = Object.entries(entry.metadata)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      if (metaStr) {
        output += ` ${color}(${metaStr})${reset}`;
      }
    }

    if (entry.data !== undefined) {
      if (entry.data instanceof Error) {
        output += `\n  ${entry.data.message}`;
        if (entry.data.stack) {
          output += `\n  ${entry.data.stack}`;
        }
      } else if (typeof entry.data === 'object') {
        try {
          output += `\n  ${JSON.stringify(entry.data, null, 2)}`;
        } catch (serializationError) {
          // Object contains circular references or non-serializable values
          // Log a fallback message - we can't use the logger here to avoid recursion
          output += `\n  [Unserializable data: ${serializationError instanceof Error ? serializationError.message : 'unknown error'}]`;
        }
      } else {
        output += ` ${entry.data}`;
      }
    }

    return output;
  }

  private log(level: LogLevel, message: string, data?: unknown, metadata?: LogMetadata): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createEntry(level, message, data, metadata);

    // Console output
    if (Logger.config.enableConsole) {
      const formattedMessage = this.formatConsoleMessage(entry);
      switch (level) {
        case 'error':
          console.error(formattedMessage);
          break;
        case 'warn':
          console.warn(formattedMessage);
          break;
        default:
          console.log(formattedMessage);
      }
    }

    // File output
    if (Logger.config.enableFile) {
      Logger.logBuffer.push(entry);

      // Immediate flush for errors
      if (level === 'error') {
        Logger.flush();
      }
    }
  }

  debug(message: string, data?: unknown, metadata?: LogMetadata): void {
    this.log('debug', message, data, metadata);
  }

  info(message: string, data?: unknown, metadata?: LogMetadata): void {
    this.log('info', message, data, metadata);
  }

  warn(message: string, data?: unknown, metadata?: LogMetadata): void {
    this.log('warn', message, data, metadata);
  }

  error(message: string, data?: unknown, metadata?: LogMetadata): void {
    this.log('error', message, data, metadata);
  }

  // Convenience methods for common patterns
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const duration = Math.round(performance.now() - start);
      this.debug(`${label} completed`, undefined, { duration });
    };
  }

  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`);
  }
}

// Default logger instance
export const logger = new Logger('App');
