import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ServerConfig } from './config.ts';
import { logger as defaultLogger } from './logger.ts';
import { type GameMetrics, gameMetrics } from './metrics.ts';
import type { RoomManager } from './room.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIST_DIR = resolve(__dirname, '../../client/dist');

const SpawnBotsBodySchema = z.object({
  count: z.number().int().min(1).max(32).default(8),
});

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

export interface RuntimeLifecycle {
  isShuttingDown: () => boolean;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > 16 * 1024) {
        rejectBody(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed);
      } catch (err: unknown) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function createGameHttpServer(
  roomManager: RoomManager,
  options: {
    config?: Partial<ServerConfig>;
    lifecycle?: RuntimeLifecycle;
    logger?: Logger;
    metrics?: GameMetrics;
    clientDistDir?: string;
  } = {},
): Server {
  const log = options.logger ?? defaultLogger;
  const metrics = options.metrics ?? gameMetrics;
  const distDir = options.clientDistDir ?? CLIENT_DIST_DIR;
  const version = options.config?.APP_VERSION ?? process.env.APP_VERSION ?? '1.0.0';
  const gitSha = options.config?.GIT_SHA ?? process.env.GIT_SHA ?? 'local-dev';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:",
    );
    const rawUrl = req.url ?? '/';
    const pathname = decodeURIComponent(rawUrl.split('?')[0] ?? '/');
    const method = req.method ?? 'GET';

    if (pathname === '/health' || pathname === '/api/stats') {
      const stats = roomManager.getStats();
      const mem = process.memoryUsage();
      const elu = performance.eventLoopUtilization();
      sendJson(res, 200, {
        ok: true,
        status: 'alive',
        version,
        gitSha,
        uptimeSec: Number(process.uptime().toFixed(2)),
        ...stats,
        rssMB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heapUsedMB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        eventLoopUtilization: Number(elu.utilization.toFixed(4)),
      });
      return;
    }

    if (pathname === '/ready') {
      const shuttingDown = options.lifecycle?.isShuttingDown() ?? false;
      const indexReady = existsSync(join(distDir, 'index.html'));
      const ready = !shuttingDown && indexReady;
      sendJson(res, ready ? 200 : 503, {
        ok: ready,
        ready,
        shuttingDown,
        clientBundlePresent: indexReady,
        version,
        gitSha,
      });
      return;
    }

    if (pathname === '/metrics') {
      const stats = roomManager.getStats();
      metrics.updateGauges(stats);
      void metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          log.error({ event: 'metrics.error', reason });
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Failed to collect metrics');
        });
      return;
    }

    const botRouteMatch = /^\/api\/rooms\/([^/]+)\/bots$/.exec(pathname);
    if (botRouteMatch) {
      const roomName = botRouteMatch[1] ?? 'Sector Alpha';
      if (method === 'POST') {
        void readJsonBody(req)
          .then((body) => {
            const parsed = SpawnBotsBodySchema.safeParse(body);
            if (!parsed.success) {
              sendJson(res, 400, { ok: false, error: 'Invalid bot count (1..32)' });
              return;
            }
            const room = roomManager.getOrCreateRoom(roomName);
            const added = room.spawnBots(parsed.data.count);
            sendJson(res, 200, {
              ok: true,
              room: room.id,
              added,
              totalBots: room.botCount,
              totalPlayers: room.playerCount,
            });
          })
          .catch((err: unknown) => {
            const code = err instanceof Error && err.message === 'ROOM_LIMIT_REACHED' ? 503 : 400;
            sendJson(res, code, { ok: false, error: 'Cannot spawn bots' });
          });
        return;
      }

      if (method === 'DELETE') {
        const room = roomManager.getRoom(roomName);
        const removed = room ? room.clearBots() : 0;
        sendJson(res, 200, { ok: true, removed });
        return;
      }
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(distDir, safePath);

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(distDir, 'index.html');
    }

    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Client build not found. Run "npm run build" first.');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });

    const stream = createReadStream(filePath);
    stream.on('error', (err: Error) => {
      log.error({ event: 'http.stream_error', filePath, reason: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal server error');
    });
    stream.pipe(res);
  });
}
