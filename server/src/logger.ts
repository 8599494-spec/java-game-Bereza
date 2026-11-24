import pino, { type Logger } from 'pino';
import type { ServerConfig } from './config.ts';

export function createLogger(
  config?: Pick<ServerConfig, 'LOG_LEVEL' | 'NODE_ENV' | 'APP_VERSION' | 'GIT_SHA'>,
): Logger {
  const level = config?.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
  return pino({
    level,
    base: {
      service: 'space-dogfight-server',
      version: config?.APP_VERSION ?? '1.0.0',
      gitSha: config?.GIT_SHA ?? 'local-dev',
    },
    redact: {
      paths: [
        'password',
        'secret',
        'token',
        'apiKey',
        'authorization',
        'cookie',
        '*.password',
        '*.secret',
        '*.token',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger: Logger = createLogger();
