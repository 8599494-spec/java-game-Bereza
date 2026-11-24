import {
  type EntityId,
  FIXED_DT,
  type InputMessage,
  type Seq,
  type ShipControlInput,
  type SnapshotMessage,
  TICK_RATE,
  type WorldState,
  addShipToWorld,
  asSeq,
  buildSnapshotFromWorld,
  createWorldState,
  removeShipFromWorld,
  stepWorldState,
} from '@game/shared';
import type { BotController } from './bot.ts';

export type SnapshotBroadcastHandler = (shipId: EntityId, snapshot: SnapshotMessage) => void;

export interface TickTimingStats {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly sampleCount: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

export class AuthoritativeMatch {
  public readonly world: WorldState;
  private readonly pendingInputs = new Map<EntityId, InputMessage[]>();
  private readonly latestInputs = new Map<EntityId, ShipControlInput>();
  private readonly bots = new Map<EntityId, BotController>();
  private readonly onSnapshot: SnapshotBroadcastHandler;
  private readonly tickDurationsMs: number[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickTargetMs = 0;

  public constructor(seed: number, onSnapshot: SnapshotBroadcastHandler) {
    this.world = createWorldState({ seed, asteroidCount: 6, homingRatio: 0.3 });
    this.onSnapshot = onSnapshot;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickTargetMs = performance.now() + 1000 / TICK_RATE;
    this.scheduleNextTick();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get botCount(): number {
    return this.bots.size;
  }

  public addPlayer(shipId: EntityId, name: string): void {
    const slotIndex = this.world.ships.length;
    addShipToWorld(this.world, { id: shipId, name, slotIndex });
    this.pendingInputs.set(shipId, []);
  }

  public addBot(bot: BotController): void {
    this.addPlayer(bot.shipId, bot.name);
    this.bots.set(bot.shipId, bot);
  }

  public removePlayer(shipId: EntityId): void {
    removeShipFromWorld(this.world, shipId);
    this.pendingInputs.delete(shipId);
    this.latestInputs.delete(shipId);
    this.bots.delete(shipId);
  }

  public removeAllBots(): EntityId[] {
    const ids = Array.from(this.bots.keys());
    for (const id of ids) {
      this.removePlayer(id);
    }
    return ids;
  }

  public queueInput(shipId: EntityId, input: InputMessage): void {
    const queue = this.pendingInputs.get(shipId);
    if (!queue) return;
    if (queue.length >= 32) {
      queue.shift();
    }
    queue.push(input);
  }

  public createSnapshotFor(shipId: EntityId): SnapshotMessage {
    const ship = this.world.ships.find((s) => s.id === shipId);
    const lastProcessedSeq: Seq = ship ? ship.lastProcessedSeq : asSeq(0);
    return buildSnapshotFromWorld(this.world, {
      yourShipId: shipId,
      lastProcessedSeq,
      serverTimeMs: performance.now(),
    });
  }

  public getTickStats(): TickTimingStats {
    if (this.tickDurationsMs.length === 0) {
      return { p50Ms: 0, p95Ms: 0, p99Ms: 0, sampleCount: 0 };
    }
    const sorted = [...this.tickDurationsMs].sort((a, b) => a - b);
    return {
      p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
      p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
      sampleCount: sorted.length,
    };
  }

  public stepOnce(): void {
    this.stepTick();
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    const intervalMs = 1000 / TICK_RATE;
    const now = performance.now();
    const delayMs = Math.max(0, this.nextTickTargetMs - now);

    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.stepTick();
      this.nextTickTargetMs += intervalMs;
      const drift = performance.now() - this.nextTickTargetMs;
      if (drift > intervalMs * 3) {
        this.nextTickTargetMs = performance.now() + intervalMs;
      }
      this.scheduleNextTick();
    }, delayMs);
  }

  private stepTick(): void {
    const t0 = performance.now();

    // Bots generate standard InputMessage using the exact same input queue as human players
    for (const bot of this.bots.values()) {
      const botInput = bot.computeInput(this.world, this.world.tick);
      this.queueInput(bot.shipId, botInput);
    }

    const stepInputs = new Map<EntityId, ShipControlInput>();

    for (const ship of this.world.ships) {
      const queue = this.pendingInputs.get(ship.id);
      const nextInput = queue?.shift();
      if (nextInput) {
        this.latestInputs.set(ship.id, nextInput);
        stepInputs.set(ship.id, nextInput);
      } else {
        const held = this.latestInputs.get(ship.id);
        if (held) {
          stepInputs.set(ship.id, {
            seq: held.seq,
            thrust: held.thrust,
            turn: held.turn,
            fire: false,
            fireHoming: false,
          });
        }
      }
    }

    stepWorldState(this.world, stepInputs, FIXED_DT);

    for (const ship of this.world.ships) {
      if (this.bots.has(ship.id)) continue;
      const snapshot = this.createSnapshotFor(ship.id);
      this.onSnapshot(ship.id, snapshot);
    }

    const elapsedMs = performance.now() - t0;
    this.tickDurationsMs.push(elapsedMs);
    if (this.tickDurationsMs.length > 600) {
      this.tickDurationsMs.shift();
    }
  }
}
