import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export function loadConfig(env = process.env) {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT environment variable: "${rawPort}". Must be an integer 1..65535.`);
  }

  const rawLogDir = env.LOG_DIR ?? path.join(repoRoot, 'logs');
  if (typeof rawLogDir !== 'string' || rawLogDir.trim().length === 0) {
    throw new Error('Invalid LOG_DIR environment variable: must be a non-empty path.');
  }

  const latencyMs = Math.max(0, Number(env.SIM_LATENCY_MS ?? 0) || 0);
  const jitterMs = Math.max(0, Number(env.SIM_JITTER_MS ?? 0) || 0);
  const dropPct = Math.max(0, Math.min(50, Number(env.SIM_DROP_PCT ?? 0) || 0));

  return Object.freeze({
    port,
    logDir: path.resolve(rawLogDir),
    clientDistDir: path.resolve(env.CLIENT_DIST_DIR ?? path.join(repoRoot, 'client', 'dist')),
    maxPayloadBytes: 8192,
    joinTimeoutMs: 5000,
    pingIntervalMs: 15000,
    rateLimitPerSec: 90,
    maxBufferedBytes: 64 * 1024,
    defaultNetSim: { latencyMs, jitterMs, dropPct },
  });
}
