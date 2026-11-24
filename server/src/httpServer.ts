import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomManager } from './room.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIST_DIR = resolve(__dirname, '../../client/dist');

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

export function createGameHttpServer(roomManager: RoomManager): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';

    if (pathname === '/health') {
      const stats = roomManager.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...stats }));
      return;
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
