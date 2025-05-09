/**
 * Logger package for Void platform
 * Provides standardized logging functionality
 */

// Log levels
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

// Environment-based configuration
const isDevelopment = process.env.NODE_ENV !== 'production';
const defaultLogLevel = isDevelopment ? LogLevel.DEBUG : LogLevel.INFO;

// Logger configuration
interface LoggerConfig {
  level: LogLevel;
  prefix?: string;
  timestamps?: boolean;
}

// Logger implementation
class Logger {
  private config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: config.level ?? defaultLogLevel,
      prefix: config.prefix,
      timestamps: config.timestamps ?? true,
    };
  }

  /**
   * Format a log message
   */
  private format(level: string, message: string): string {
    const parts: string[] = [];
    
    if (this.config.timestamps) {
      parts.push(`[${new Date().toISOString()}]`);
    }
    
    if (this.config.prefix) {
      parts.push(`[${this.config.prefix}]`);
  }

    parts.push(`[${level}]`);
    parts.push(message);
    
    return parts.join(' ');
  }

  /**
   * Log an error message
   */
  error(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.ERROR) {
      console.error(this.format('ERROR', message), ...args);
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.WARN) {
      console.warn(this.format('WARN', message), ...args);
    }
  }

  /**
   * Log an info message
   */
  info(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.INFO) {
      console.info(this.format('INFO', message), ...args);
    }
  }

  /**
   * Log a debug message
   */
  debug(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.DEBUG) {
      console.debug(this.format('DEBUG', message), ...args);
    }
  }

  /**
   * Create a new logger with a different configuration
   */
  withConfig(config: Partial<LoggerConfig>): Logger {
    return new Logger({
      ...this.config,
      ...config,
    });
  }
}

// Export a default logger instance
export default new Logger();

// Export the Logger class for custom instances
export { Logger };
