import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
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
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

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

export function createGameHttpServer(roomManager: RoomManager): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const pathname = decodeURIComponent(rawUrl.split('?')[0] ?? '/');
    const method = req.method ?? 'GET';

    if (pathname === '/health' || pathname === '/api/stats') {
      const stats = roomManager.getStats();
      const mem = process.memoryUsage();
      const elu = performance.eventLoopUtilization();
      sendJson(res, 200, {
        ok: true,
        ...stats,
        rssMB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heapUsedMB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        eventLoopUtilization: Number(elu.utilization.toFixed(4)),
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
          .catch(() => {
            sendJson(res, 400, { ok: false, error: 'Malformed JSON body' });
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
    let filePath = join(CLIENT_DIST_DIR, safePath);

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(CLIENT_DIST_DIR, 'index.html');
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
      console.error(`[HTTP] Failed to stream ${filePath}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal server error');
    });
    stream.pipe(res);
  });
}
