import { z } from 'zod';

const OriginsSchema = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_ORIGINS: OriginsSchema,
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(500).default(24),
  MAX_ROOMS: z.coerce.number().int().min(1).max(512).default(32),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(256).default(160),
  JOIN_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  DEFAULT_LATENCY_MS: z.coerce.number().min(0).max(1000).default(0),
  DEFAULT_JITTER_MS: z.coerce.number().min(0).max(500).default(0),
  DEFAULT_DROP_RATE: z.coerce.number().min(0).max(0.9).default(0),
  APP_VERSION: z.string().min(1).default('1.0.0'),
  GIT_SHA: z.string().min(1).default('local-dev'),
});

export type ServerConfig = z.infer<typeof EnvSchema>;

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server environment configuration: ${details}`);
  }
  return parsed.data;
}
