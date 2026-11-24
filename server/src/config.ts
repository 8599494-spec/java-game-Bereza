import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(256).default(160),
  DEFAULT_LATENCY_MS: z.coerce.number().min(0).max(1000).default(0),
  DEFAULT_JITTER_MS: z.coerce.number().min(0).max(500).default(0),
  DEFAULT_DROP_RATE: z.coerce.number().min(0).max(0.9).default(0),
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
