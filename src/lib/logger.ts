/**
 * Logger utility for the server
 * Provides consistent logging with timestamps and log levels
 */

// Log levels
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Environment-based log level
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as LogLevel;

// Log level priority
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

// Should this log level be displayed based on the configured level?
const shouldLog = (level: LogLevel): boolean => {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[LOG_LEVEL];
};

// Format the log message
const formatLog = (level: LogLevel, message: string, data?: unknown): string => {
  const timestamp = new Date().toISOString();
  const dataStr = data !== undefined ? `\n${JSON.stringify(data, null, 2)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
};

// Logger implementation
export const logger = {
  debug: (message: string, data?: unknown) => {
    if (shouldLog('debug')) {
      console.debug(formatLog('debug', message, data));
    }
  },
  
  info: (message: string, data?: unknown) => {
    if (shouldLog('info')) {
      console.info(formatLog('info', message, data));
    }
  },
  
  warn: (message: string, data?: unknown) => {
    if (shouldLog('warn')) {
      console.warn(formatLog('warn', message, data));
    }
  },
  
  error: (message: string, error?: unknown) => {
    if (shouldLog('error')) {
      console.error(formatLog('error', message, error));
      if (error instanceof Error) {
        console.error(error.stack);
      }
    }
  }
};
