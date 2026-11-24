import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  type ServerMessage,
  asRoomId,
  asSeq,
  asTick,
  binaryCodec,
  jsonCodec,
} from '../../shared/src/index.ts';
import { loadServerConfig } from '../src/config.ts';
import { createGameHttpServer } from '../src/httpServer.ts';
import { RoomManager } from '../src/room.ts';
import { attachWebSocketServer } from '../src/wsServer.ts';

function nextServerMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), 3000);
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      const raw: unknown = isBinary
        ? data instanceof ArrayBuffer
          ? data
          : new Uint8Array(data as Buffer)
        : String(data);
      const parsed = isBinary ? binaryCodec.decodeServer(raw) : jsonCodec.decodeServer(raw);
      if (!parsed.ok) {
        reject(new Error(parsed.error));
        return;
      }
      resolve(parsed.value);
    });
  });
}

describe('WebSocket multiplayer integration', () => {
  it('connects two clients to one room, exchanges chat, and processes binary input & ping', async () => {
    const cfg = loadServerConfig({});
    const roomManager = new RoomManager(cfg);
    const httpServer = createGameHttpServer(roomManager);
    const wss = attachWebSocketServer(httpServer, roomManager, cfg);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/ws`;

    const ws1 = new WebSocket(url);
    ws1.binaryType = 'arraybuffer';
    const ws2 = new WebSocket(url);
    ws2.binaryType = 'arraybuffer';

    try {
      await Promise.all([
        new Promise<void>((resolve) => ws1.once('open', () => resolve())),
        new Promise<void>((resolve) => ws2.once('open', () => resolve())),
      ]);

      const welcome1Promise = nextServerMessage(ws1);
      ws1.send(jsonCodec.encodeClient({ type: 'join', room: asRoomId('IntRoom'), name: 'Alpha' }));
      const w1 = await welcome1Promise;
      expect(w1.type).toBe('welcome');

      const welcome2Promise = nextServerMessage(ws2);
      ws2.send(jsonCodec.encodeClient({ type: 'join', room: asRoomId('IntRoom'), name: 'Bravo' }));
      const w2 = await welcome2Promise;
      expect(w2.type).toBe('welcome');

      // Send chat from ws1 and verify ws2 receives it
      const chatOn2Promise = new Promise<Extract<ServerMessage, { type: 'chat' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chat not received')), 3000);
        const handler = (data: WebSocket.RawData, isBinary: boolean): void => {
          if (isBinary) return;
          const parsed = jsonCodec.decodeServer(String(data));
          if (parsed.ok && parsed.value.type === 'chat') {
            clearTimeout(timer);
            ws2.off('message', handler);
            resolve(parsed.value);
          }
        };
        ws2.on('message', handler);
      });

      ws1.send(jsonCodec.encodeClient({ type: 'chat', text: 'Ping from Alpha' }));
      const chatMsg = await chatOn2Promise;
      expect(chatMsg.fromName).toBe('Alpha');
      expect(chatMsg.text).toBe('Ping from Alpha');

      // Send binary input packet
      ws1.send(
        binaryCodec.encodeClient({
          type: 'input',
          seq: asSeq(1),
          tick: asTick(1),
          thrust: true,
          turn: 0.2,
          fire: false,
          fireHoming: false,
        }),
      );

      expect(roomManager.getRoom('IntRoom')?.playerCount).toBe(2);
    } finally {
      ws1.close();
      ws2.close();
      roomManager.getRoom('IntRoom')?.match.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('rejects invalid input before join with an error packet', async () => {
    const cfg = loadServerConfig({});
    const roomManager = new RoomManager(cfg);
    const httpServer = createGameHttpServer(roomManager);
    const wss = attachWebSocketServer(httpServer, roomManager, cfg);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      const errPromise = nextServerMessage(ws);
      ws.send(
        binaryCodec.encodeClient({
          type: 'input',
          seq: asSeq(1),
          tick: asTick(0),
          thrust: false,
          turn: 0,
          fire: false,
          fireHoming: false,
        }),
      );
      const msg = await errPromise;
      expect(msg.type).toBe('error');
    } finally {
      ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
