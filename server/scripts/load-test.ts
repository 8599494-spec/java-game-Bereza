import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { asRoomId, asSeq, asTick, binaryCodec, jsonCodec } from '../../shared/src/index.ts';
import { loadServerConfig } from '../src/config.ts';
import { createGameHttpServer } from '../src/httpServer.ts';
import { RoomManager } from '../src/room.ts';
import { attachWebSocketServer } from '../src/wsServer.ts';

interface LoadTierResult {
  readonly clients: number;
  readonly tickP50Ms: number;
  readonly tickP95Ms: number;
  readonly tickP99Ms: number;
  readonly elu: number;
  readonly rssMB: number;
  readonly downKBps: number;
}

async function runTier(clientCount: number, durationMs = 2200): Promise<LoadTierResult> {
  const cfg = loadServerConfig({ MAX_PLAYERS_PER_ROOM: '256' });
  const roomManager = new RoomManager(cfg);
  const httpServer = createGameHttpServer(roomManager);
  const wss = attachWebSocketServer(httpServer, roomManager, cfg);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const sockets: WebSocket[] = [];
  let bytesReceived = 0;

  for (let i = 0; i < clientCount; i += 1) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (isBinary && data instanceof ArrayBuffer) {
        bytesReceived += data.byteLength;
      } else if (Buffer.isBuffer(data)) {
        bytesReceived += data.byteLength;
      }
    });
    sockets.push(ws);
  }

  await Promise.all(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.OPEN) resolve();
          else ws.once('open', () => resolve());
        }),
    ),
  );

  for (let i = 0; i < sockets.length; i += 1) {
    sockets[i]?.send(
      jsonCodec.encodeClient({
        type: 'join',
        room: asRoomId('LoadArena'),
        name: `LoadBot-${i + 1}`,
      }),
    );
  }

  await new Promise((r) => setTimeout(r, 150));

  const eluStart = performance.eventLoopUtilization();
  let seq = 0;
  const inputTimer = setInterval(() => {
    seq += 1;
    for (let i = 0; i < sockets.length; i += 1) {
      const ws = sockets[i];
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const packet = binaryCodec.encodeClient({
        type: 'input',
        seq: asSeq(seq),
        tick: asTick(seq),
        thrust: true,
        turn: Math.sin(seq * 0.1 + i),
        fire: seq % 10 === 0,
        fireHoming: false,
      });
      ws.send(packet);
    }
  }, 33);

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(inputTimer);

  const eluDiff = performance.eventLoopUtilization(eluStart);
  const stats = roomManager.getStats();
  const rssMB = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
  const downKBps = Number((bytesReceived / 1024 / (durationMs / 1000)).toFixed(1));

  for (const ws of sockets) {
    ws.close();
  }
  roomManager.getRoom('LoadArena')?.match.stop();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  return {
    clients: clientCount,
    tickP50Ms: stats.tickP50Ms,
    tickP95Ms: stats.tickP95Ms,
    tickP99Ms: stats.tickP99Ms,
    elu: Number(eluDiff.utilization.toFixed(3)),
    rssMB,
    downKBps,
  };
}

const tiers = [8, 32, 64, 128];
const results: LoadTierResult[] = [];

for (const n of tiers) {
  const res = await runTier(n);
  results.push(res);
}

console.log('\n| Clients (N) | Tick p50 (ms) | Tick p95 (ms) | Tick p99 (ms) | Event Loop Util | RSS (MB) | Outbound (KB/s) | Budget 33ms |');
console.log('|---:|---:|---:|---:|---:|---:|---:|:---:|');
for (const r of results) {
  const status = r.tickP99Ms <= 33.3 ? 'OK' : 'EXCEEDED';
  console.log(
    `| ${r.clients} | ${r.tickP50Ms.toFixed(3)} | ${r.tickP95Ms.toFixed(3)} | ${r.tickP99Ms.toFixed(3)} | ${r.elu.toFixed(3)} | ${r.rssMB.toFixed(1)} | ${r.downKBps.toFixed(1)} | ${status} |`,
  );
}