import type { Server as HttpServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { binaryCodec, type EntityId, jsonCodec } from '@game/shared';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import type { ServerConfig } from './config.ts';
import { type GameRoom, RoomManager } from './room.ts';

function rawDataToUnknownPayload(data: RawData, isBinary: boolean): unknown {
  if (!isBinary) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return new TextDecoder().decode(data);
  }

  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const merged = Buffer.concat(data);
  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
}

function sendErrorAndClose(socket: WebSocket, code: string, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(jsonCodec.encodeServer({ type: 'error', code, message }));
    } catch {
      // Ignore send errors while closing broken socket
    }
    socket.close(1008, message.slice(0, 120));
  }
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  roomManager: RoomManager,
  config: ServerConfig,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket: WebSocket, req) => {
    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    let currentRoom: GameRoom | null = null;
    let currentShipId: EntityId | null = null;

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const payload: unknown = rawDataToUnknownPayload(data, isBinary);
      const parsed = isBinary
        ? binaryCodec.decodeClient(payload)
        : jsonCodec.decodeClient(payload);

      if (!parsed.ok) {
        console.warn(`[WS ${remoteIp}] Invalid message rejected: ${parsed.error}`);
        sendErrorAndClose(socket, 'INVALID_MESSAGE', parsed.error);
        return;
      }

      const msg = parsed.value;
      switch (msg.type) {
        case 'join': {
          if (currentRoom && currentShipId !== null) {
            currentRoom.removePlayer(currentShipId);
          }
          const room = roomManager.getOrCreateRoom(msg.room);
          const session = room.addPlayer(socket, msg.name, config);
          if (!session) {
            sendErrorAndClose(socket, 'ROOM_FULL', 'Room has reached max players');
            return;
          }
          currentRoom = room;
          currentShipId = session.id;
          break;
        }
        case 'input': {
          if (!currentRoom || currentShipId === null) {
            sendErrorAndClose(socket, 'NOT_JOINED', 'Send join message before input');
            return;
          }
          currentRoom.handleInput(currentShipId, msg);
          break;
        }
        case 'chat': {
          if (!currentRoom || currentShipId === null) {
            sendErrorAndClose(socket, 'NOT_JOINED', 'Send join message before chat');
            return;
          }
          currentRoom.broadcastChat(currentShipId, msg.text);
          break;
        }
        case 'ping': {
          const pong = {
            type: 'pong' as const,
            clientTimeMs: msg.clientTimeMs,
            serverTimeMs: performance.now(),
          };
          if (currentRoom && currentShipId !== null) {
            currentRoom.sendDirect(currentShipId, pong);
          } else if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              isBinary ? binaryCodec.encodeServer(pong) : jsonCodec.encodeServer(pong),
            );
          }
          break;
        }
        case 'netConfig': {
          if (currentRoom && currentShipId !== null) {
            currentRoom.updateNetConfig(currentShipId, msg);
          }
          break;
        }
        default: {
          const _exhaustive: never = msg;
          console.warn(`[WS ${remoteIp}] Unhandled message variant: ${JSON.stringify(_exhaustive)}`);
        }
      }
    });

    socket.on('close', () => {
      if (currentRoom && currentShipId !== null) {
        currentRoom.removePlayer(currentShipId);
        currentRoom = null;
        currentShipId = null;
      }
    });

    socket.on('error', (err: Error) => {
      console.error(`[WS ${remoteIp}] Socket error: ${err.message}`);
    });
  });

  return wss;
}