import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { streamReplayToResponse } from './matchLog.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createAppServer(config, roomManager, netSim, getWsCount = () => 0) {
  return http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url || '/';
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(rawUrl.split('?')[0]);
      } catch {
        sendJson(res, 400, { error: 'Malformed URL encoding' });
        return;
      }

      if (rawUrl.includes('..') || decodedPath.includes('..')) {
        sendJson(res, 400, { error: 'Path traversal is forbidden' });
        return;
      }

      if (req.method === 'GET' && decodedPath === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptimeSec: +process.uptime().toFixed(2),
          wsClients: getWsCount(),
          rssMb: +(process.memoryUsage().rss / (1024 * 1024)).toFixed(2),
          netSim: netSim.getSettings(),
        });
        return;
      }

      if (req.method === 'GET' && decodedPath === '/api/stats') {
        sendJson(res, 200, {
          wsClients: getWsCount(),
          rssMb: +(process.memoryUsage().rss / (1024 * 1024)).toFixed(2),
          netSim: netSim.getSettings(),
          matches: roomManager.getAllMatchStats(),
        });
        return;
      }

      if (req.method === 'POST' && decodedPath === '/api/net-sim') {
        const body = await readJsonBody(req);
        sendJson(res, 200, netSim.update(body));
        return;
      }

      if (req.method === 'GET' && decodedPath === '/api/rooms') {
        sendJson(res, 200, roomManager.listRooms());
        return;
      }

      if (req.method === 'POST' && decodedPath === '/api/rooms') {
        const body = await readJsonBody(req);
        if (!body || typeof body.name !== 'string' || body.name.trim().length < 2) {
          sendJson(res, 400, { error: 'Room name must be at least 2 characters' });
          return;
        }
        const created = roomManager.createTemplate(body);
        sendJson(res, 201, created);
        return;
      }

      if (req.method === 'GET' && decodedPath.startsWith('/api/replays/')) {
        const roomId = decodedPath.slice('/api/replays/'.length);
        if (!roomId) {
          sendJson(res, 400, { error: 'Missing roomId' });
          return;
        }
        await streamReplayToResponse(config.logDir, roomId, res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
      const resolvedFile = path.resolve(config.clientDistDir, relativePath);

      if (!resolvedFile.startsWith(config.clientDistDir)) {
        sendJson(res, 403, { error: 'Access denied' });
        return;
      }

      let stat;
      try {
        stat = await fs.promises.stat(resolvedFile);
      } catch {
        stat = null;
      }

      if (!stat || !stat.isFile()) {
        sendJson(res, 404, { error: 'Not found. Build client with "npm run build" or use Vite dev server.' });
        return;
      }

      const ext = path.extname(resolvedFile).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      await pipeline(fs.createReadStream(resolvedFile), res);
    } catch (err) {
      if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.code === 'ECONNRESET') return;
      if (!res.headersSent) {
        sendJson(res, err.statusCode || 500, { error: err.message || 'Internal Server Error' });
      }
    }
  });
}
