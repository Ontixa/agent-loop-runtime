import winston from 'winston';
import chalk from 'chalk';
import { ensureDir } from './util/atomic-file.js';
import { dirname } from 'path';
import { redactSecrets } from './util/redact.js';

/**
 * Logger singleton with structured JSON file output
 * and colorized console formatting.
 *
 * Runtime logs default to `.agentloop/logs/agentloop.log` relative to CWD.
 * Override with AGENTLOOP_LOG_FILE (used by tests and daemon mode).
 */
class Logger {
  private static instance: Logger;
  private logger: winston.Logger;
  private lastLogTimes = new Map<string, number>();
  private level: string;

  private constructor(level: string = 'info') {
    this.level = level;
    const logFile = process.env.AGENTLOOP_LOG_FILE || 'logs/agentloop.log';
    ensureDir(dirname(logFile));

    this.logger = winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level: lvl, message, agent, task, mission, ...meta }) => {
          const agentTag = agent ? chalk.cyan(`[${agent}]`) : '';
          const taskTag = task ? chalk.yellow(`[${String(task).slice(0, 8)}]`) : '';
          const missionTag = mission ? chalk.magenta(`[${String(mission).slice(0, 12)}]`) : '';

          const levels: Record<string, string> = {
            error: chalk.red('ERROR'),
            warn: chalk.yellow('WARN '),
            info: chalk.blue('INFO '),
            debug: chalk.gray('DEBUG')
          };

          let logLine = `${chalk.gray(timestamp)} ${levels[lvl]} ${missionTag}${agentTag}${taskTag} ${message}`;

          // Add essential metadata
          const essentialKeys = ['priority', 'retryCount', 'status', 'count', 'duration', 'state'];
          const metaEntries = Object.entries(meta).filter(([k]) => essentialKeys.includes(k));
          if (metaEntries.length > 0) {
            logLine += chalk.gray(` {${metaEntries.map(([k, v]) => `${k}=${v}`).join(' ')}}`);
          }

          return logLine;
        })
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        new winston.transports.File({
          filename: logFile,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            // Redact secrets before serializing to JSON
            winston.format((info) => {
              info.message = redactSecrets(String(info.message));
              return info;
            })(),
            winston.format.json()
          ),
          maxsize: 5242880,
          maxFiles: 5
        })
      ]
    });
  }

  /**
   * Get or create the Logger singleton instance
   */
  static getInstance(level?: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(level);
    } else if (level && level !== Logger.instance.level) {
      Logger.instance.level = level;
      Logger.instance.logger.level = level;
    }
    return Logger.instance;
  }

  /**
   * Check if message should be sampled to avoid log spam
   */
  private shouldSample(message: string, intervalMs: number): boolean {
    const now = Date.now();
    const last = this.lastLogTimes.get(message) || 0;
    if (now - last > intervalMs) {
      this.lastLogTimes.set(message, now);
      return true;
    }
    return false;
  }

  /**
   * Log an informational message
   */
  info(message: string, metadata?: { agent?: string; task?: string; mission?: string; [key: string]: unknown }) {
    this.logger.info(message, metadata);
  }

  /**
   * Log a warning message
   */
  warn(message: string, metadata?: { agent?: string; task?: string; mission?: string; [key: string]: unknown }) {
    this.logger.warn(message, metadata);
  }

  /**
   * Log an error message
   */
  error(message: string, metadata?: { agent?: string; task?: string; mission?: string; error?: Error | unknown; [key: string]: unknown }) {
    this.logger.error(message, metadata);
  }

  /**
   * Log a debug message with automatic sampling
   */
  debug(message: string, metadata?: { agent?: string; task?: string; mission?: string; [key: string]: unknown }, sampleMs = 5000) {
    if (!this.shouldSample(message, sampleMs)) return;
    this.logger.debug(message, metadata);
  }
}

export const logger = Logger.getInstance();

/**
 * Set the global log level
 */
export function setLogLevel(level: 'error' | 'warn' | 'info' | 'debug') {
  Logger.getInstance(level);
}
