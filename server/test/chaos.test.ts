import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type ServerMessage, asRoomId, jsonCodec } from '../../shared/src/index.ts';
import { loadServerConfig } from '../src/config.ts';
import { createGameHttpServer } from '../src/httpServer.ts';
import { createLogger } from '../src/logger.ts';
import { GameMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room.ts';
import { createGracefulShutdown } from '../src/shutdown.ts';
import { attachWebSocketServer } from '../src/wsServer.ts';

function waitForWelcome(ws: WebSocket): Promise<Extract<ServerMessage, { type: 'welcome' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for welcome')), 3000);
    const handler = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const parsed = jsonCodec.decodeServer(String(data));
      if (parsed.ok && parsed.value.type === 'welcome') {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed.value);
      }
    };
    ws.on('message', handler);
  });
}

describe('Lab 08 M1/M2 Production Hardening & Chaos Tests', () => {
  it('enforces ALLOWED_ORIGINS and MAX_CONNECTIONS_PER_IP on WebSocket handshake', async () => {
    const cfg = loadServerConfig({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://play.spacedogfight.example',
      LOG_LEVEL: 'silent',
      MAX_CONNECTIONS_PER_IP: '2',
    });
    const log = createLogger(cfg);
    const metrics = new GameMetrics();
    const roomManager = new RoomManager(cfg, log, metrics);
    const httpServer = createGameHttpServer(roomManager, { config: cfg, logger: log, metrics });
    const wss = attachWebSocketServer(httpServer, roomManager, cfg, { logger: log, metrics });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/ws`;

    try {
      // 1. Disallowed origin must fail handshake with HTTP 403
      const badOriginCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { origin: 'https://evil-site.example' });
        ws.once('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
      });
      expect(badOriginCode).toBe(403);

      // 2. Allowed origin succeeds up to MAX_CONNECTIONS_PER_IP = 2
      const ok1 = new WebSocket(url, { origin: 'https://play.spacedogfight.example' });
      const ok2 = new WebSocket(url, { origin: 'https://play.spacedogfight.example' });
      await Promise.all([
        new Promise<void>((r) => ok1.once('open', () => r())),
        new Promise<void>((r) => ok2.once('open', () => r())),
      ]);

      // 3. 3rd connection from same IP must fail handshake with HTTP 429
      const ipLimitCode = await new Promise<number>((resolve) => {
        const ws3 = new WebSocket(url, { origin: 'https://play.spacedogfight.example' });
        ws3.once('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
      });
      expect(ipLimitCode).toBe(429);

      ok1.close();
      ok2.close();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('sends shutdown message, closes sockets with code 1001, and exits 0 on SIGTERM', async () => {
    const cfg = loadServerConfig({ LOG_LEVEL: 'silent', APP_VERSION: '1.0.0', GIT_SHA: 'abc1234' });
    const log = createLogger(cfg);
    const metrics = new GameMetrics();
    let shuttingDown = false;
    const lifecycle = { isShuttingDown: () => shuttingDown };

    const roomManager = new RoomManager(cfg, log, metrics);
    const httpServer = createGameHttpServer(roomManager, {
      config: cfg,
      lifecycle,
      logger: log,
      metrics,
    });
    const wss = attachWebSocketServer(httpServer, roomManager, cfg, {
      lifecycle,
      logger: log,
      metrics,
    });

    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      httpServer,
      wss,
      roomManager,
      logger: log,
      forceTimeoutMs: 5000,
      onExit: (code) => {
        exitCode = code;
      },
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((r) => ws.once('open', () => r()));

    const welcomePromise = waitForWelcome(ws);
    ws.send(jsonCodec.encodeClient({ type: 'join', room: asRoomId('GraceRoom'), name: 'Pilot1' }));
    await welcomePromise;

    const receivedTypes: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const parsed = jsonCodec.decodeServer(String(data));
      if (parsed.ok) receivedTypes.push(parsed.value.type);
    });

    const closeCodePromise = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });

    const startMs = performance.now();
    shuttingDown = true;
    await shutdown.trigger('SIGTERM');
    const elapsedMs = performance.now() - startMs;

    const closeCode = await closeCodePromise;
    expect(receivedTypes).toContain('shutdown');
    expect(closeCode).toBe(1001);
    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('isolates healthy rooms when a rogue client floods 1000 garbage frames/s', async () => {
    const cfg = loadServerConfig({ LOG_LEVEL: 'silent' });
    const log = createLogger(cfg);
    const metrics = new GameMetrics();
    const roomManager = new RoomManager(cfg, log, metrics);
    const httpServer = createGameHttpServer(roomManager, { config: cfg, logger: log, metrics });
    const wss = attachWebSocketServer(httpServer, roomManager, cfg, { logger: log, metrics });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/ws`;

    // Room A: Healthy match with 12 bots running 30Hz physics
    const healthyRoom = roomManager.getOrCreateRoom('HealthyRoom');
    healthyRoom.spawnBots(12);

    try {
      await new Promise((r) => setTimeout(r, 250));
      const baselineP99 = healthyRoom.getTickStats().p99Ms;

      // Rogue flood: 25 rapid connections blasting malformed frames (~1000 frames total)
      const floodPromises: Promise<number>[] = [];
      for (let c = 0; c < 25; c += 1) {
        floodPromises.push(
          new Promise<number>((resolve) => {
            const attacker = new WebSocket(url);
            attacker.once('open', () => {
              for (let f = 0; f < 40; f += 1) {
                if (attacker.readyState === WebSocket.OPEN) {
                  attacker.send('{"type":"corrupted_garbage_flood",');
                }
              }
            });
            attacker.once('close', (code) => resolve(code));
            attacker.once('error', () => resolve(1006));
          }),
        );
      }

      const closeCodes = await Promise.all(floodPromises);
      expect(closeCodes.every((code) => code === 1008 || code === 1006)).toBe(true);

      await new Promise((r) => setTimeout(r, 250));
      const underAttackP99 = healthyRoom.getTickStats().p99Ms;

      // Healthy room tick time remains well within 33.33ms budget and unaffected
      expect(underAttackP99).toBeLessThan(15);
      expect(underAttackP99 - baselineP99).toBeLessThan(10);

      // Prometheus /metrics exposes rejections and gauges
      const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsText = await metricsRes.text();
      expect(metricsText).toContain('game_ws_rejections_total{reason="invalid_message"}');
      expect(metricsText).toContain('game_active_rooms 1');
    } finally {
      roomManager.stopAllRooms();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
