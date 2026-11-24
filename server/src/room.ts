import {
  type Codec,
  type EntityId,
  type InputMessage,
  type NetConfigMessage,
  type RoomId,
  type ServerMessage,
  TICK_RATE,
  asEntityId,
  asRoomId,
  binaryCodec,
  getCodec,
} from '@game/shared';
import type { WebSocket } from 'ws';
import type { ServerConfig } from './config.ts';
import { TypedEventEmitter } from './events.ts';
import { AuthoritativeMatch } from './match.ts';
import { NetworkSimulator } from './netSim.ts';

export interface PlayerSession {
  readonly id: EntityId;
  readonly name: string;
  readonly socket: WebSocket;
  readonly netSim: NetworkSimulator;
  codec: Codec;
}

export type RoomEvents = {
  playerJoined: { readonly roomId: RoomId; readonly shipId: EntityId; readonly name: string };
  playerLeft: { readonly roomId: RoomId; readonly shipId: EntityId };
  empty: { readonly roomId: RoomId };
};

export class GameRoom extends TypedEventEmitter<RoomEvents> {
  public readonly id: RoomId;
  private readonly maxPlayers: number;
  private readonly sessions = new Map<EntityId, PlayerSession>();
  private readonly match: AuthoritativeMatch;
  private nextShipNumber = 1;

  public constructor(id: RoomId, config: ServerConfig) {
    super();
    this.id = id;
    this.maxPlayers = config.MAX_PLAYERS_PER_ROOM;
    const seed = Array.from(id).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 1337);
    this.match = new AuthoritativeMatch(seed, (shipId, snapshot) => {
      const session = this.sessions.get(shipId);
      if (!session) return;
      session.netSim.schedule(() => {
        this.sendToSession(session, snapshot);
      });
    });
    this.match.start();
  }

  public get playerCount(): number {
    return this.sessions.size;
  }

  public addPlayer(socket: WebSocket, name: string, config: ServerConfig): PlayerSession | null {
    if (this.sessions.size >= this.maxPlayers) {
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

  public removePlayer(shipId: EntityId): void {
    const session = this.sessions.get(shipId);
    if (!session) return;
    session.netSim.dispose();
    this.sessions.delete(shipId);
    this.match.removePlayer(shipId);
    this.emit('playerLeft', { roomId: this.id, shipId });

    if (this.sessions.size === 0) {
      this.match.stop();
      this.emit('empty', { roomId: this.id });
    }
  }

  public handleInput(shipId: EntityId, input: InputMessage): void {
    const session = this.sessions.get(shipId);
    if (!session) return;
    session.netSim.schedule(() => {
      this.match.queueInput(shipId, input);
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

  private sendToSession(session: PlayerSession, msg: ServerMessage): void {
    if (session.socket.readyState !== session.socket.OPEN) return;
    try {
      const payload = session.codec.encodeServer(msg);
      session.socket.send(payload);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Room ${this.id}] Failed to send packet to ship ${session.id}: ${reason}`);
    }
  }
}

export class RoomManager {
  private readonly rooms = new Map<RoomId, GameRoom>();
  private readonly config: ServerConfig;

  public constructor(config: ServerConfig) {
    this.config = config;
  }

  public getOrCreateRoom(rawRoomName: string): GameRoom {
    const roomId = asRoomId(rawRoomName.trim() || 'Sector Alpha');
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new GameRoom(roomId, this.config);
      room.on('playerJoined', ({ roomId: rId, shipId, name }) => {
        console.log(`[Room ${rId}] Pilot "${name}" joined as ship #${shipId}`);
      });
      room.on('playerLeft', ({ roomId: rId, shipId }) => {
        console.log(`[Room ${rId}] Ship #${shipId} disconnected`);
      });
      room.on('empty', ({ roomId: rId }) => {
        console.log(`[Room ${rId}] Empty, disposing room`);
        this.rooms.delete(rId);
      });
      this.rooms.set(roomId, room);
    }
    return room;
  }

  public getStats(): { rooms: number; players: number } {
    let players = 0;
    for (const room of this.rooms.values()) {
      players += room.playerCount;
    }
    return { rooms: this.rooms.size, players };
  }
}
