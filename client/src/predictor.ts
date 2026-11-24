import {
  ARENA,
  type EntityId,
  FIXED_DT,
  type InputMessage,
  type ShipSnapshotEntity,
  type SimShip,
  type SnapshotMessage,
  type Vector2,
  ZERO_VEC2,
  asSeq,
  integrateShip,
  shortestWrapDelta,
  vec2,
  wrapCoord,
} from '@game/shared';

export class LocalShipPredictor {
  public predictionEnabled = true;
  private ship: SimShip | null = null;
  private pendingInputs: InputMessage[] = [];
  private visualOffset: Vector2 = ZERO_VEC2;
  private lastCorrectionPx = 0;

  public reset(): void {
    this.ship = null;
    this.pendingInputs = [];
    this.visualOffset = ZERO_VEC2;
    this.lastCorrectionPx = 0;
  }

  public get queueLength(): number {
    return this.pendingInputs.length;
  }

  public get lastReconcileErrorPx(): number {
    return this.lastCorrectionPx;
  }

  public recordInput(input: InputMessage): void {
    this.pendingInputs.push(input);
    if (this.pendingInputs.length > 120) {
      this.pendingInputs.shift();
    }
    if (this.predictionEnabled && this.ship && this.ship.alive) {
      integrateShip(this.ship, input, FIXED_DT, ARENA);
    }
  }

  public reconcile(snapshot: SnapshotMessage): void {
    const authEntity = snapshot.entities.find(
      (e): e is ShipSnapshotEntity => e.kind === 'ship' && e.id === snapshot.yourShipId,
    );
    if (!authEntity) return;

    const prevPos = this.ship ? this.ship.pos : authEntity.pos;

    const reconciled: SimShip = {
      id: authEntity.id,
      name: authEntity.name,
      slotIndex: 0,
      pos: authEntity.pos,
      vel: authEntity.vel,
      angle: authEntity.angle,
      hp: authEntity.hp,
      maxHp: 100,
      alive: authEntity.alive,
      thrusting: authEntity.thrusting,
      score: authEntity.score,
      fireCooldown: 0,
      invulnTimer: 0,
      respawnTimer: 0,
      lastProcessedSeq: snapshot.lastProcessedSeq,
    };

    this.pendingInputs = this.pendingInputs.filter((inp) => inp.seq > snapshot.lastProcessedSeq);

    if (this.predictionEnabled && reconciled.alive) {
      for (const inp of this.pendingInputs) {
        integrateShip(reconciled, inp, FIXED_DT, ARENA);
      }
    }

    const errX = shortestWrapDelta(reconciled.pos.x, prevPos.x, ARENA.width);
    const errY = shortestWrapDelta(reconciled.pos.y, prevPos.y, ARENA.height);
    const errorMag = Math.hypot(errX, errY);
    this.lastCorrectionPx = errorMag;

    if (errorMag > 0.25 && errorMag < 240) {
      this.visualOffset = vec2(this.visualOffset.x + errX, this.visualOffset.y + errY);
    } else {
      this.visualOffset = ZERO_VEC2;
    }

    this.ship = reconciled;
  }

  public decaySmoothing(dt: number): void {
    const factor = Math.exp(-18 * dt);
    this.visualOffset = vec2(this.visualOffset.x * factor, this.visualOffset.y * factor);
    if (Math.hypot(this.visualOffset.x, this.visualOffset.y) < 0.05) {
      this.visualOffset = ZERO_VEC2;
    }
  }

  public getRenderShip(localShipId: EntityId | null): ShipSnapshotEntity | null {
    if (!this.ship || localShipId === null || this.ship.id !== localShipId) {
      return null;
    }
    return {
      kind: 'ship',
      id: this.ship.id,
      pos: vec2(
        wrapCoord(this.ship.pos.x + this.visualOffset.x, ARENA.width),
        wrapCoord(this.ship.pos.y + this.visualOffset.y, ARENA.height),
      ),
      vel: this.ship.vel,
      angle: this.ship.angle,
      alive: this.ship.alive,
      thrusting: this.ship.thrusting,
      hp: this.ship.hp,
      score: this.ship.score,
      name: this.ship.name,
    };
  }

  public static initialSeq(): ReturnType<typeof asSeq> {
    return asSeq(0);
  }
}
