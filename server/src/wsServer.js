import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ALLOWED_TYPES = new Set(['join', 'chat', 'leave']);

function parseAndValidateMessage(rawBuffer) {
  let parsed;
  try {
    parsed = JSON.parse(rawBuffer.toString('utf8'));
  } catch {
    return { error: 'Malformed JSON payload', code: 1003 };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Payload must be a JSON object', code: 1003 };
  }

  if (typeof parsed.type !== 'string' || !ALLOWED_TYPES.has(parsed.type)) {
    return { error: `Unknown message type: ${String(parsed.type)}`, code: 1008 };
  }

  if (parsed.type === 'join') {
    if (typeof parsed.roomId !== 'string' || parsed.roomId.trim().length === 0 || parsed.roomId.length > 48) {
      return { error: 'Invalid roomId in join message', code: 1008 };
    }
    if (typeof parsed.playerName !== 'string' || parsed.playerName.trim().length === 0 || parsed.playerName.length > 24) {
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

export function attachWebSocketServer(httpServer, roomManager, config) {
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const client = {
      id: randomUUID().slice(0, 8),
      ws,
      name: null,
      room: null,
      missedPongs: 0,
      windowStart: Date.now(),
      msgCount: 0,
    };
    sessions.set(ws, client);

    // Якщо клієнт не надіслав валідний join за 5 с — закриваємо сокет
    const joinTimer = setTimeout(() => {
      if (!client.room && ws.readyState === 1) {
        ws.close(4001, 'Join timeout (5s)');
      }
    }, config.joinTimeoutMs);

    ws.on('pong', () => {
      client.missedPongs = 0;
    });

    ws.on('message', (rawData, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'Binary frames not supported');
        return;
      }

      // Rate limit: максимум config.rateLimitPerSec повідомлень на секунду
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

      const { data, error, code } = parseAndValidateMessage(rawData);
      if (error) {
        ws.close(code, error);
        return;
      }

      if (data.type === 'join') {
        clearTimeout(joinTimer);
        if (client.room) {
          client.room.removeClient(client.id);
          client.room = null;
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

      if (data.type === 'chat') {
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

  // Heartbeat: ping раз на 15 с, два пропущені pong -> розрив
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
