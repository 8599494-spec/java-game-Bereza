import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { type EntityId, binaryCodec, jsonCodec } from '@game/shared';
import type { Logger } from 'pino';
import { type RawData, type VerifyClientCallbackAsync, WebSocket, WebSocketServer } from 'ws';
import type { ServerConfig } from './config.ts';
import type { RuntimeLifecycle } from './httpServer.ts';
import { logger as defaultLogger } from './logger.ts';
import { type GameMetrics, gameMetrics } from './metrics.ts';
import type { GameRoom, RoomManager } from './room.ts';

const MAX_WS_PAYLOAD_BYTES = 4096;
const HEARTBEAT_INTERVAL_MS = 20_000;

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, buf) => sum + buf.byteLength, 0);
  return data.byteLength;
}

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

export function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function isOriginAllowed(originHeader: string | undefined, config: ServerConfig): boolean {
  // Non-browser clients (Node load tests / CLI) may omit Origin unless production explicitly enforces it
  if (!originHeader) {
    return config.ALLOWED_ORIGINS.length === 0 || config.NODE_ENV !== 'production';
  }
  if (config.ALLOWED_ORIGINS.length === 0) {
    return true;
  }
  return config.ALLOWED_ORIGINS.includes(originHeader);
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  roomManager: RoomManager,
  config: ServerConfig,
  options: {
    lifecycle?: RuntimeLifecycle;
    logger?: Logger;
    metrics?: GameMetrics;
  } = {},
): WebSocketServer {
  const log = options.logger ?? defaultLogger;
  const metrics = options.metrics ?? gameMetrics;
  const connectionsPerIp = new Map<string, number>();

  const verifyClient: VerifyClientCallbackAsync = (info, cb) => {
    if (options.lifecycle?.isShuttingDown()) {
      metrics.recordRejection('shutting_down');
      cb(false, 503, 'Server shutting down');
      return;
    }

    if (!isOriginAllowed(info.origin, config)) {
      metrics.recordRejection('invalid_origin');
      log.warn({ event: 'ws.rejected', reason: 'invalid_origin', origin: info.origin ?? 'none' });
      cb(false, 403, 'Origin not allowed');
      return;
    }

    const ip = extractClientIp(info.req);
    const activeFromIp = connectionsPerIp.get(ip) ?? 0;
    if (activeFromIp >= config.MAX_CONNECTIONS_PER_IP) {
      metrics.recordRejection('ip_limit');
      log.warn({ event: 'ws.rejected', reason: 'ip_limit', ip, activeFromIp });
      cb(false, 429, 'Too many connections from IP');
      return;
    }

    cb(true);
  };

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    verifyClient,
  });

  const heartbeatTimer = setInterval(() => {
    for (const rawClient of wss.clients) {
      const client = rawClient as AliveWebSocket;
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  wss.on('connection', (rawSocket: WebSocket, req) => {
    const socket = rawSocket as AliveWebSocket;
    socket.isAlive = true;

    const remoteIp = extractClientIp(req);
    connectionsPerIp.set(remoteIp, (connectionsPerIp.get(remoteIp) ?? 0) + 1);

    let currentRoom: GameRoom | null = null;
    let currentShipId: EntityId | null = null;
    let cleanedUp = false;

    const cleanupConnection = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(joinDeadlineTimer);

      const prevCount = connectionsPerIp.get(remoteIp) ?? 1;
      if (prevCount <= 1) {
        connectionsPerIp.delete(remoteIp);
      } else {
        connectionsPerIp.set(remoteIp, prevCount - 1);
      }

      if (currentRoom && currentShipId !== null) {
        currentRoom.removePlayer(currentShipId);
        currentRoom = null;
        currentShipId = null;
      }
    };

    const joinDeadlineTimer = setTimeout(() => {
      if (currentRoom === null && socket.readyState === WebSocket.OPEN) {
        metrics.recordRejection('join_timeout');
        log.warn({ event: 'ws.rejected', reason: 'join_timeout', ip: remoteIp });
        sendErrorAndClose(socket, 'JOIN_TIMEOUT', 'Did not join a room in time');
      }
    }, config.JOIN_TIMEOUT_MS);
    joinDeadlineTimer.unref();

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      socket.isAlive = true;
      metrics.recordPacketIn(rawDataByteLength(data));

      const payload: unknown = rawDataToUnknownPayload(data, isBinary);
      const parsed = isBinary ? binaryCodec.decodeClient(payload) : jsonCodec.decodeClient(payload);

      if (!parsed.ok) {
        metrics.recordRejection('invalid_message');
        log.warn({
          event: 'ws.rejected',
          reason: 'invalid_message',
          roomId: currentRoom?.id,
          playerId: currentShipId ?? undefined,
          detail: parsed.error,
        });
        sendErrorAndClose(socket, 'INVALID_MESSAGE', parsed.error);
        return;
      }

      const msg = parsed.value;
      switch (msg.type) {
        case 'join': {
          if (currentRoom && currentShipId !== null) {
            currentRoom.removePlayer(currentShipId);
            currentRoom = null;
            currentShipId = null;
          }
          let room: GameRoom;
          try {
            room = roomManager.getOrCreateRoom(msg.room);
          } catch {
            metrics.recordRejection('room_limit');
            sendErrorAndClose(socket, 'ROOM_LIMIT', 'Server reached maximum active rooms');
            return;
          }
          const session = room.addPlayer(socket, msg.name, config);
          if (!session) {
            metrics.recordRejection('room_full');
            log.warn({ event: 'ws.rejected', reason: 'room_full', roomId: room.id });
            sendErrorAndClose(socket, 'ROOM_FULL', 'Room has reached max players');
            return;
          }
          clearTimeout(joinDeadlineTimer);
          currentRoom = room;
          currentShipId = session.id;
          break;
        }
        case 'input': {
          if (!currentRoom || currentShipId === null) {
            metrics.recordRejection('not_joined');
            sendErrorAndClose(socket, 'NOT_JOINED', 'Send join message before input');
            return;
          }
          currentRoom.handleInput(currentShipId, msg);
          break;
        }
        case 'chat': {
          if (!currentRoom || currentShipId === null) {
            metrics.recordRejection('not_joined');
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
            const encoded = isBinary ? binaryCodec.encodeServer(pong) : jsonCodec.encodeServer(pong);
            metrics.recordPacketOut(
              encoded instanceof ArrayBuffer ? encoded.byteLength : Buffer.byteLength(encoded, 'utf8'),
            );
            socket.send(encoded);
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
          log.warn({ event: 'ws.unhandled_variant', variant: _exhaustive });
        }
      }
    });

    socket.on('close', cleanupConnection);
    socket.on('error', (err: Error) => {
      log.warn({
        event: 'ws.socket_error',
        roomId: currentRoom?.id,
        playerId: currentShipId ?? undefined,
        reason: err.message,
      });
      cleanupConnection();
    });
  });

  return wss;
}
