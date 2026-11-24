import { EventEmitter } from 'node:events';
import { AuthoritativeMatch } from './match.js';
import { MatchLogger } from './matchLog.js';

export class Room extends EventEmitter {
  #clients = new Map();
  #chatHistory = [];
  #logger;
  #match;
  #maxBufferedBytes;
  #netSim;

  constructor({
    id,
    name,
    asteroidCount = 6,
    homingRatio = 0.3,
    maxPlayers = 8,
    logDir,
    maxBufferedBytes = 65536,
    netSim,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.asteroidCount = asteroidCount;
    this.homingRatio = homingRatio;
    this.maxPlayers = maxPlayers;
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#netSim = netSim;
    this.#logger = new MatchLogger(logDir, id);

    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.#match = new AuthoritativeMatch({
      seed,
      asteroidCount,
      homingRatio,
      onBroadcastTick: (match, events) => this.#broadcastSnapshots(match, events),
    });

    this.on('error', (err) => {
      console.error(`[Room:${this.id}] emitter error:`, err.message);
    });

    this.#match.start();
    this.#logger.write({ type: 'room-created', roomId: this.id, name: this.name, seed });
  }

  get playerCount() {
    return this.#clients.size;
  }

  getMatchStats() {
    return {
      roomId: this.id,
      name: this.name,
      ...this.#match.getStats(),
    };
  }

  toSummary() {
    return {
      id: this.id,
      name: this.name,
      asteroidCount: this.asteroidCount,
      homingRatio: this.homingRatio,
      players: this.#clients.size,
      maxPlayers: this.maxPlayers,
    };
  }

  getRoster() {
    return [...this.#clients.values()].map((c) => ({ id: c.id, shipId: c.shipId, name: c.name }));
  }

  addClient(client) {
    if (this.#clients.size >= this.maxPlayers) {
      return false;
    }
    client.shipId = this.#match.addPlayer(client.name);
    this.#clients.set(client.id, client);
    this.#logger.write({
      type: 'join',
      roomId: this.id,
      clientId: client.id,
      shipId: client.shipId,
      playerName: client.name,
    });
    this.emit('player-joined', client);

    this.sendToClient(client, {
      type: 'joined',
      shipId: client.shipId,
      seed: this.#match.seed,
      tickRate: 30,
      codec: client.useJsonCodec ? 'json' : 'binary',
      netSim: this.#netSim.getSettings(),
      room: this.toSummary(),
      roster: this.getRoster(),
      history: this.#chatHistory.slice(-20),
    });

    this.broadcast(
      {
        type: 'system',
        text: `${client.name} entered ${this.name}`,
        roster: this.getRoster(),
      },
      { excludeId: client.id },
    );

    return true;
  }

  handleClientInput(client, validatedInput) {
    if (!client.shipId) return;
    this.#netSim.schedule(() => {
      if (!this.#clients.has(client.id)) return;
      this.#match.queueInput(client.shipId, validatedInput);
    });
  }

  removeClient(clientId) {
    const client = this.#clients.get(clientId);
    if (!client) return;
    if (client.shipId) {
      this.#match.removePlayer(client.shipId);
    }
    this.#clients.delete(clientId);
    this.#logger.write({ type: 'leave', roomId: this.id, clientId: client.id, playerName: client.name });
    this.emit('player-left', client);

    if (this.#clients.size > 0) {
      this.broadcast({
        type: 'system',
        text: `${client.name} left the sector`,
        roster: this.getRoster(),
      });
    } else {
      this.emit('empty', this);
    }
  }

  postChat(clientId, text) {
    const client = this.#clients.get(clientId);
    if (!client) return;
    const message = {
      type: 'chat',
      roomId: this.id,
      from: client.name,
      text,
      ts: Date.now(),
    };
    this.#chatHistory.push(message);
    if (this.#chatHistory.length > 50) {
      this.#chatHistory.shift();
    }
    this.#logger.write({ type: 'chat', roomId: this.id, from: client.name, text });
    this.emit('chat', message);
    this.broadcast(message);
  }

  #broadcastSnapshots(match, events) {
    if (this.#clients.size === 0) return;

    for (const client of this.#clients.values()) {
      if (client.ws.readyState !== 1) continue;
      if (client.ws.bufferedAmount > this.#maxBufferedBytes) continue;

      const payload = match.buildPersonalizedSnapshot(client.shipId, {
        binary: !client.useJsonCodec,
      });

      this.#netSim.schedule(() => {
        if (client.ws.readyState === 1 && client.ws.bufferedAmount <= this.#maxBufferedBytes) {
          client.ws.send(payload);
        }
      });
    }

    if (events.length > 0) {
      this.broadcast({ type: 'events', events });
    }
  }

  sendToClient(client, payload) {
    if (client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > this.#maxBufferedBytes) return;
    client.ws.send(JSON.stringify(payload));
  }

  broadcast(payload, { excludeId = null } = {}) {
    const encoded = JSON.stringify(payload);
    for (const client of this.#clients.values()) {
      if (client.id === excludeId || client.ws.readyState !== 1) continue;
      if (client.ws.bufferedAmount > this.#maxBufferedBytes) continue;
      client.ws.send(encoded);
    }
  }

  async close() {
    this.#match.stop();
    for (const client of this.#clients.values()) {
      if (client.ws.readyState === 1) {
        client.ws.close(1001, 'Room closed');
      }
    }
    this.#clients.clear();
    await this.#logger.close();
  }
}

const PRESET_TEMPLATES = [
  { id: 'sector-alpha', name: 'Sector Alpha (Training)', asteroidCount: 5, homingRatio: 0.25, maxPlayers: 6 },
  { id: 'belt-omega', name: 'Asteroid Belt Omega', asteroidCount: 8, homingRatio: 0.4, maxPlayers: 8 },
  { id: 'swarm-core', name: 'Homing Swarm Core', asteroidCount: 10, homingRatio: 0.65, maxPlayers: 8 },
];

export class RoomManager {
  #activeRooms = new Map();
  #customTemplates = new Map();
  #config;
  #netSim;

  constructor(config, netSim) {
    this.#config = config;
    this.#netSim = netSim;
    for (const tpl of PRESET_TEMPLATES) {
      this.#customTemplates.set(tpl.id, tpl);
    }
  }

  listRooms() {
    const result = [];
    const seen = new Set();

    for (const room of this.#activeRooms.values()) {
      seen.add(room.id);
      result.push(room.toSummary());
    }

    for (const tpl of this.#customTemplates.values()) {
      if (!seen.has(tpl.id)) {
        result.push({ ...tpl, players: 0 });
      }
    }

    return result;
  }

  getAllMatchStats() {
    return [...this.#activeRooms.values()].map((r) => r.getMatchStats());
  }

  createTemplate({ name, asteroidCount = 6, homingRatio = 0.3, maxPlayers = 8 }) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    const id = `${slug || 'sector'}-${Date.now().toString(36).slice(-4)}`;
    const template = {
      id,
      name: name.trim().slice(0, 36),
      asteroidCount: Math.max(2, Math.min(20, Number(asteroidCount) || 6)),
      homingRatio: Math.max(0, Math.min(1, Number(homingRatio) || 0.3)),
      maxPlayers: Math.max(2, Math.min(16, Number(maxPlayers) || 8)),
    };
    this.#customTemplates.set(id, template);
    return { ...template, players: 0 };
  }

  getOrCreateRoom(roomId) {
    let room = this.#activeRooms.get(roomId);
    if (room) return room;

    const tpl = this.#customTemplates.get(roomId);
    if (!tpl) return null;

    room = new Room({
      ...tpl,
      logDir: this.#config.logDir,
      maxBufferedBytes: this.#config.maxBufferedBytes,
      netSim: this.#netSim,
    });

    room.once('empty', async () => {
      this.#activeRooms.delete(room.id);
      await room.close();
    });

    this.#activeRooms.set(room.id, room);
    return room;
  }

  async closeAll() {
    const rooms = [...this.#activeRooms.values()];
    this.#activeRooms.clear();
    await Promise.all(rooms.map((room) => room.close()));
  }
}
