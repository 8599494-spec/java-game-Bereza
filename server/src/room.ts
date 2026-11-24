import {
  type Codec,
  type EntityId,
  type InputMessage,
  type NetConfigMessage,
  type RoomId,
  type ServerMessage,
  TICK_RATE,
  TokenBucketRateLimiter,
  asEntityId,
  asRoomId,
  binaryCodec,
  getCodec,
} from '@game/shared';
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import { BotController } from './bot.ts';
import type { ServerConfig } from './config.ts';
import { TypedEventEmitter } from './events.ts';
import { logger as defaultLogger } from './logger.ts';
import { AuthoritativeMatch, type TickTimingStats } from './match.ts';
import { type GameMetrics, gameMetrics } from './metrics.ts';
import { NetworkSimulator } from './netSim.ts';

export interface PlayerSession {
  readonly id: EntityId;
  readonly name: string;
  readonly socket: WebSocket;
  readonly netSim: NetworkSimulator;
  readonly inputLimiter: TokenBucketRateLimiter;
  codec: Codec;
}

export type RoomEvents = {
  playerJoined: { readonly roomId: RoomId; readonly shipId: EntityId; readonly name: string };
  playerLeft: { readonly roomId: RoomId; readonly shipId: EntityId };
  chatMessage: {
    readonly roomId: RoomId;
    readonly fromShipId: EntityId;
    readonly fromName: string;
    readonly text: string;
  };
  empty: { readonly roomId: RoomId };
};

function payloadByteLength(payload: ArrayBuffer | string): number {
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  return Buffer.byteLength(payload, 'utf8');
}

export class GameRoom extends TypedEventEmitter<RoomEvents> {
  public readonly id: RoomId;
  private readonly maxPlayers: number;
  private readonly sessions = new Map<EntityId, PlayerSession>();
  public readonly match: AuthoritativeMatch;
  private readonly log: Logger;
  private readonly metrics: GameMetrics;
  private nextShipNumber = 1;

  public constructor(
    id: RoomId,
    config: ServerConfig,
    autoStart = true,
    log: Logger = defaultLogger,
    metrics: GameMetrics = gameMetrics,
  ) {
    super();
    this.id = id;
    this.maxPlayers = config.MAX_PLAYERS_PER_ROOM;
    this.log = log.child({ roomId: id });
    this.metrics = metrics;

    const seed = Array.from(id).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 1337);
    this.match = new AuthoritativeMatch(seed, (shipId, snapshot) => {
      const session = this.sessions.get(shipId);
      if (!session) return;
      session.netSim.schedule(() => {
        this.sendToSession(session, snapshot);
      });
    });
    if (autoStart) {
      this.match.start();
    }
  }

  public get playerCount(): number {
    return this.sessions.size;
  }

  public get botCount(): number {
    return this.match.botCount;
  }

  public getTickStats(): TickTimingStats {
    return this.match.getTickStats();
  }

  public addPlayer(socket: WebSocket, name: string, config: ServerConfig): PlayerSession | null {
    if (this.sessions.size + this.match.botCount >= this.maxPlayers) {
      return null;
    }

    const shipId = asEntityId(this.nextShipNumber++);
    const netSim = new NetworkSimulator({
      latencyMs: config.DEFAULT_LATENCY_MS,
      jitterMs: config.DEFAULT_JITTER_MS,
      dropRate: config.DEFAULT_DROP_RATE,
    });

    const session: PlayerSession = {
      id: shipId,
      name,
      socket,
      netSim,
      inputLimiter: new TokenBucketRateLimiter(90, 60, performance.now()),
      codec: binaryCodec,
    };

    this.sessions.set(shipId, session);
    this.match.addPlayer(shipId, name);

    const initialSnapshot = this.match.createSnapshotFor(shipId);
    this.sendToSession(session, {
      type: 'welcome',
      shipId,
      roomId: this.id,
      tickRate: TICK_RATE,
      snapshot: initialSnapshot,
    });

    this.emit('playerJoined', { roomId: this.id, shipId, name });
    return session;
  }

  public spawnBots(count: number): number {
    const safeCount = Math.max(0, Math.min(32, Math.floor(count)));
    let spawned = 0;
    for (let i = 0; i < safeCount; i += 1) {
      if (this.sessions.size + this.match.botCount >= this.maxPlayers) break;
      const botId = asEntityId(this.nextShipNumber++);
      const bot = new BotController(botId, `Bot-${botId}`);
      this.match.addBot(bot);
      spawned += 1;
    }
    return spawned;
  }

  public clearBots(): number {
    return this.match.removeAllBots().length;
  }

  public removePlayer(shipId: EntityId): void {
    const session = this.sessions.get(shipId);
    if (!session) return;
    session.netSim.dispose();
    this.sessions.delete(shipId);
    this.match.removePlayer(shipId);
    this.emit('playerLeft', { roomId: this.id, shipId });

    if (this.sessions.size === 0 && this.match.botCount === 0) {
      this.match.stop();
      this.emit('empty', { roomId: this.id });
    }
  }

  public handleInput(shipId: EntityId, input: InputMessage): boolean {
    const session = this.sessions.get(shipId);
    if (!session) return false;
    if (!session.inputLimiter.tryConsume(performance.now(), 1)) {
      return false;
    }
    session.netSim.schedule(() => {
      this.match.queueInput(shipId, input);
    });
    return true;
  }

  public broadcastChat(fromShipId: EntityId, text: string): void {
    const sender = this.sessions.get(fromShipId);
    if (!sender) return;
    const msg: ServerMessage = {
      type: 'chat',
      fromShipId,
      fromName: sender.name,
      text,
    };
    for (const session of this.sessions.values()) {
      this.sendToSession(session, msg);
    }
    this.emit('chatMessage', {
      roomId: this.id,
      fromShipId,
      fromName: sender.name,
      text,
    });
  }

  public updateNetConfig(shipId: EntityId, msg: NetConfigMessage): void {
    const session = this.sessions.get(shipId);
    if (!session) return;
    session.netSim.update({
      latencyMs: msg.latencyMs,
      jitterMs: msg.jitterMs,
      dropRate: msg.dropRate,
    });
    if (msg.codec) {
      session.codec = getCodec(msg.codec);
    }
  }

  public sendDirect(shipId: EntityId, msg: ServerMessage): void {
    const session = this.sessions.get(shipId);
    if (!session) return;
    this.sendToSession(session, msg);
  }

  public stopAll(): void {
    for (const session of this.sessions.values()) {
      session.netSim.dispose();
    }
    this.sessions.clear();
    this.match.stop();
  }

  private sendToSession(session: PlayerSession, msg: ServerMessage): void {
    if (session.socket.readyState !== session.socket.OPEN) return;
    try {
      const payload = session.codec.encodeServer(msg);
      this.metrics.recordPacketOut(payloadByteLength(payload));
      session.socket.send(payload);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn({ event: 'packet.send_failed', playerId: session.id, reason });
    }
  }
}

export class RoomManager {
  private readonly rooms = new Map<RoomId, GameRoom>();
  private readonly config: ServerConfig;
  private readonly log: Logger;
  private readonly metrics: GameMetrics;

  public constructor(config: ServerConfig, log: Logger = defaultLogger, metrics: GameMetrics = gameMetrics) {
    this.config = config;
    this.log = log;
    this.metrics = metrics;
  }

  public getOrCreateRoom(rawRoomName: string, autoStart = true): GameRoom {
    const roomId = asRoomId(rawRoomName.trim() || 'Sector Alpha');
    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.config.MAX_ROOMS) {
        throw new Error('ROOM_LIMIT_REACHED');
      }
      room = new GameRoom(roomId, this.config, autoStart, this.log, this.metrics);
      this.log.info({ event: 'room.created', roomId }, 'Room created');

      room.on('playerJoined', ({ roomId: rId, shipId, name }) => {
        this.log.info({ event: 'player.joined', roomId: rId, playerId: shipId, playerName: name });
      });
      room.on('playerLeft', ({ roomId: rId, shipId }) => {
        this.log.info({ event: 'player.left', roomId: rId, playerId: shipId });
      });
      room.on('empty', ({ roomId: rId }) => {
        this.log.info({ event: 'room.disposed', roomId: rId });
        this.rooms.delete(rId);
      });
      this.rooms.set(roomId, room);
    }
    return room;
  }

  public getRoom(rawRoomName: string): GameRoom | undefined {
    const roomId = asRoomId(rawRoomName.trim());
    return this.rooms.get(roomId);
  }

  public stopAllRooms(): void {
    for (const room of this.rooms.values()) {
      room.stopAll();
    }
    this.rooms.clear();
  }

  public getStats(): {
    rooms: number;
    players: number;
    bots: number;
    tickP50Ms: number;
    tickP95Ms: number;
    tickP99Ms: number;
  } {
    let players = 0;
    let bots = 0;
    let maxP50 = 0;
    let maxP95 = 0;
    let maxP99 = 0;

    for (const room of this.rooms.values()) {
      players += room.playerCount;
      bots += room.botCount;
      const t = room.getTickStats();
      if (t.p50Ms > maxP50) maxP50 = t.p50Ms;
      if (t.p95Ms > maxP95) maxP95 = t.p95Ms;
      if (t.p99Ms > maxP99) maxP99 = t.p99Ms;
    }

    return {
      rooms: this.rooms.size,
      players,
      bots,
      tickP50Ms: maxP50,
      tickP95Ms: maxP95,
      tickP99Ms: maxP99,
    };
  }
}
