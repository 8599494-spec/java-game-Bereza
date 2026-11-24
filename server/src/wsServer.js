import { randomUUID } from 'node:crypto';
import { MSG_TYPE, decodeBinaryPacket, encodePingPongBinary, validateInputPacket } from '@game/shared';
import { WebSocketServer } from 'ws';

const ALLOWED_JSON_TYPES = new Set(['join', 'chat', 'leave', 'input', 'ping', 'net-sim', 'codec']);

function parseJsonControlMessage(rawBuffer) {
  let parsed;
  try {
    parsed = JSON.parse(rawBuffer.toString('utf8'));
  } catch {
    return { error: 'Malformed JSON payload', code: 1003 };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Payload must be a JSON object', code: 1003 };
  }

  if (typeof parsed.type !== 'string' || !ALLOWED_JSON_TYPES.has(parsed.type)) {
    return { error: `Unknown message type: ${String(parsed.type)}`, code: 1008 };
  }

  if (parsed.type === 'join') {
    if (typeof parsed.roomId !== 'string' || parsed.roomId.trim().length === 0 || parsed.roomId.length > 48) {
      return { error: 'Invalid roomId in join message', code: 1008 };
    }
    if (
      typeof parsed.playerName !== 'string' ||
      parsed.playerName.trim().length === 0 ||
      parsed.playerName.length > 24
    ) {
      return { error: 'Invalid playerName in join message', code: 1008 };
    }
  }

  if (parsed.type === 'chat') {
    if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0 || parsed.text.length > 300) {
      return { error: 'Chat text must be 1..300 chars', code: 1008 };
    }
  }

  return { data: parsed };
}

export function attachWebSocketServer(httpServer, roomManager, config, netSim) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
  });

  const sessions = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const useJsonCodec = url.searchParams.get('codec') === 'json';
    const qLat = url.searchParams.get('latency');
    const qJit = url.searchParams.get('jitter');
    const qDrop = url.searchParams.get('drop');
    if (qLat !== null || qJit !== null || qDrop !== null) {
      netSim.update({
        latencyMs: qLat !== null ? Number(qLat) : undefined,
        jitterMs: qJit !== null ? Number(qJit) : undefined,
        dropPct: qDrop !== null ? Number(qDrop) : undefined,
      });
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, { useJsonCodec });
    });
  });

  wss.on('connection', (ws, { useJsonCodec = false } = {}) => {
    const client = {
      id: randomUUID().slice(0, 8),
      ws,
      name: null,
      room: null,
      shipId: null,
      useJsonCodec,
      missedPongs: 0,
      windowStart: Date.now(),
      msgCount: 0,
    };
    sessions.set(ws, client);

    const joinTimer = setTimeout(() => {
      if (!client.room && ws.readyState === 1) {
        ws.close(4001, 'Join timeout (5s)');
      }
    }, config.joinTimeoutMs);

    ws.on('pong', () => {
      client.missedPongs = 0;
    });

    ws.on('message', (rawData, isBinary) => {
      const now = Date.now();
      if (now - client.windowStart >= 1000) {
        client.windowStart = now;
        client.msgCount = 0;
      }
      client.msgCount += 1;
      if (client.msgCount > config.rateLimitPerSec) {
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      // 1. Бінарний трафік (ArrayBuffer / DataView)
      if (isBinary) {
        let packet;
        try {
          packet = decodeBinaryPacket(rawData);
        } catch (err) {
          ws.close(1003, err.message);
          return;
        }

        if (packet.kind === 'ping') {
          netSim.schedule(() => {
            if (ws.readyState === 1) {
              ws.send(encodePingPongBinary(MSG_TYPE.PONG, packet.clientTimeMs));
            }
          });
          return;
        }

        if (packet.kind === 'input') {
          if (!client.room) {
            ws.close(1008, 'Must join a room before sending input');
            return;
          }
          const valid = validateInputPacket(packet);
          if (!valid) {
            ws.close(1008, 'Invalid input values');
            return;
          }
          client.room.handleClientInput(client, valid);
          return;
        }

        ws.close(1003, 'Unexpected binary frame type');
        return;
      }

      // 2. Текстові JSON-повідомлення (join, chat, leave, налаштування netSim або JSON-режим)
      const { data, error, code } = parseJsonControlMessage(rawData);
      if (error) {
        ws.close(code, error);
        return;
      }

      if (data.type === 'ping') {
        netSim.schedule(() => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'pong', clientTimeMs: Number(data.clientTimeMs) || 0 }));
          }
        });
        return;
      }

      if (data.type === 'net-sim') {
        const updated = netSim.update(data);
        if (client.room) {
          client.room.broadcast({ type: 'net-sim', ...updated });
        }
        return;
      }

      if (data.type === 'codec') {
        client.useJsonCodec = data.codec === 'json';
        return;
      }

      if (data.type === 'join') {
        clearTimeout(joinTimer);
        if (client.room) {
          client.room.removeClient(client.id);
          client.room = null;
        }
        if (data.codec === 'json' || data.codec === 'binary') {
          client.useJsonCodec = data.codec === 'json';
        }
        client.name = data.playerName.trim();
        const room = roomManager.getOrCreateRoom(data.roomId.trim());
        if (!room) {
          ws.close(4004, 'Room not found');
          return;
        }
        const ok = room.addClient(client);
        if (!ok) {
          ws.close(4003, 'Room is full');
          return;
        }
        client.room = room;
        return;
      }

      if (!client.room) {
        ws.close(1008, 'Must join a room first');
        return;
      }

      if (data.type === 'input') {
        const valid = validateInputPacket(data);
        if (!valid) {
          ws.close(1008, 'Invalid JSON input values');
          return;
        }
        client.room.handleClientInput(client, valid);
      } else if (data.type === 'chat') {
        client.room.postChat(client.id, data.text.trim());
      } else if (data.type === 'leave') {
        client.room.removeClient(client.id);
        client.room = null;
        ws.close(1000, 'Left room');
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (client.room) {
        client.room.removeClient(client.id);
        client.room = null;
      }
      sessions.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`[WS:${client.id}] socket error:`, err.message);
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const [ws, client] of sessions.entries()) {
      if (client.missedPongs >= 2) {
        ws.terminate();
        continue;
      }
      client.missedPongs += 1;
      if (ws.readyState === 1) {
        ws.ping();
      }
    }
  }, config.pingIntervalMs);

  return {
    getClientCount() {
      return sessions.size;
    },
    async closeAll() {
      clearInterval(heartbeatInterval);
      for (const ws of sessions.keys()) {
        if (ws.readyState === 1) {
          ws.close(1001, 'Server shutting down');
        }
      }
      sessions.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
