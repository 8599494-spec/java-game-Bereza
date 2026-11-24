import { Counter, Gauge, Registry, Summary, collectDefaultMetrics } from 'prom-client';

export type WsRejectReason =
  | 'invalid_origin'
  | 'ip_limit'
  | 'join_timeout'
  | 'invalid_message'
  | 'room_limit'
  | 'room_full'
  | 'not_joined'
  | 'shutting_down';

export class GameMetrics {
  public readonly registry: Registry;
  public readonly connectedPlayers: Gauge;
  public readonly activeRooms: Gauge;
  public readonly activeBots: Gauge;
  public readonly messagesTotal: Counter<'direction'>;
  public readonly bytesTotal: Counter<'direction'>;
  public readonly tickDurationSec: Summary;
  public readonly rejectionsTotal: Counter<'reason'>;

  public constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: 'node_' });

    this.connectedPlayers = new Gauge({
      name: 'game_connected_players',
      help: 'Current number of connected human WebSocket players',
      registers: [this.registry],
    });

    this.activeRooms = new Gauge({
      name: 'game_active_rooms',
      help: 'Current number of active game rooms',
      registers: [this.registry],
    });

    this.activeBots = new Gauge({
      name: 'game_active_bots',
      help: 'Current number of active AI bots across all rooms',
      registers: [this.registry],
    });

    this.messagesTotal = new Counter({
      name: 'game_ws_messages_total',
      help: 'Total WebSocket messages processed by direction',
      labelNames: ['direction'] as const,
      registers: [this.registry],
    });

    this.bytesTotal = new Counter({
      name: 'game_ws_bytes_total',
      help: 'Total WebSocket payload bytes transferred by direction',
      labelNames: ['direction'] as const,
      registers: [this.registry],
    });

    this.tickDurationSec = new Summary({
      name: 'game_tick_duration_seconds',
      help: 'Authoritative 30Hz simulation step duration in seconds',
      percentiles: [0.5, 0.95, 0.99],
      maxAgeSeconds: 60,
      ageBuckets: 5,
      registers: [this.registry],
    });

    this.rejectionsTotal = new Counter({
      name: 'game_ws_rejections_total',
      help: 'Rejected WebSocket connections or frames grouped by reason',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });
  }

  public recordPacketIn(byteLength: number): void {
    this.messagesTotal.inc({ direction: 'in' }, 1);
    this.bytesTotal.inc({ direction: 'in' }, Math.max(0, byteLength));
  }

  public recordPacketOut(byteLength: number): void {
    this.messagesTotal.inc({ direction: 'out' }, 1);
    this.bytesTotal.inc({ direction: 'out' }, Math.max(0, byteLength));
  }

  public recordRejection(reason: WsRejectReason): void {
    this.rejectionsTotal.inc({ reason }, 1);
  }

  public updateGauges(stats: { rooms: number; players: number; bots: number; tickP99Ms: number }): void {
    this.activeRooms.set(stats.rooms);
    this.connectedPlayers.set(stats.players);
    this.activeBots.set(stats.bots);
    if (stats.tickP99Ms > 0) {
      this.tickDurationSec.observe(stats.tickP99Ms / 1000);
    }
  }
}

export const gameMetrics = new GameMetrics();
