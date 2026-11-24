import pino, {} from 'pino';
export function createLogger(config) {
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
export const logger = createLogger();
