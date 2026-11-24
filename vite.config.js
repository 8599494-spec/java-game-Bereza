import fs from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'mock-rooms-api',
      configureServer(server) {
        server.middlewares.use('/api/rooms', (req, res, next) => {
          if (req.url && !req.url.startsWith('?') && req.url !== '/') {
            next();
            return;
          }
          const url = new URL(req.url || '/', 'http://localhost');
          const fail = url.searchParams.get('fail');

          if (fail === 'timeout') {
            setTimeout(() => {
              if (!res.writableEnded) {
                res.statusCode = 504;
                res.end('Gateway Timeout');
              }
            }, 6000);
            return;
          }

          if (fail === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.end('{ broken_json: [1, 2, ');
            return;
          }

          const raw = fs.readFileSync('public/api/rooms.json', 'utf8');
          const rooms = JSON.parse(raw).map((room) => ({
            ...room,
            players: Math.max(1, Math.min(room.maxPlayers, room.players + Math.floor(Math.random() * 3) - 1)),
          }));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(rooms));
        });
      },
    },
  ],
});
