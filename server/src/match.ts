import { performance } from 'node:perf_hooks';
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
  buildSnapshotFromWorld,
  createWorldState,
  removeShipFromWorld,
  stepWorldState,
} from '@game/shared';

export type SnapshotBroadcastHandler = (shipId: EntityId, snapshot: SnapshotMessage) => void;

export class AuthoritativeMatch {
  public readonly world: WorldState;
  private readonly pendingInputs = new Map<EntityId, InputMessage[]>();
  private readonly latestInputs = new Map<EntityId, ShipControlInput>();
  private readonly onSnapshot: SnapshotBroadcastHandler;
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

  public addPlayer(shipId: EntityId, name: string): void {
    const slotIndex = this.world.ships.length;
    addShipToWorld(this.world, { id: shipId, name, slotIndex });
    this.pendingInputs.set(shipId, []);
  }

  public removePlayer(shipId: EntityId): void {
    removeShipFromWorld(this.world, shipId);
    this.pendingInputs.delete(shipId);
    this.latestInputs.delete(shipId);
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
    const lastProcessedSeq: Seq = ship ? ship.lastProcessedSeq : (0 as Seq);
    return buildSnapshotFromWorld(this.world, {
      yourShipId: shipId,
      lastProcessedSeq,
      serverTimeMs: performance.now(),
    });
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
      const snapshot = this.createSnapshotFor(ship.id);
      this.onSnapshot(ship.id, snapshot);
    }
  }
}
