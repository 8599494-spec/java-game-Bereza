import {
  ARENA,
  type EntityId,
  type SnapshotEntity,
  type SnapshotMessage,
  type asRadians,
  normalizeAngle,
  shortestWrapDelta,
  vec2,
  wrapCoord,
} from '@game/shared';

interface BufferedSnapshot {
  readonly receivedAtMs: number;
  readonly snapshot: SnapshotMessage;
}

export const INTERPOLATION_DELAY_MS = 100;

function lerpAngle(a: number, b: number, t: number): ReturnType<typeof asRadians> {
  const diff = normalizeAngle(b - a);
  return normalizeAngle(a + diff * t);
}

function interpolateEntity(a: SnapshotEntity, b: SnapshotEntity, t: number): SnapshotEntity {
  const dx = shortestWrapDelta(a.pos.x, b.pos.x, ARENA.width);
  const dy = shortestWrapDelta(a.pos.y, b.pos.y, ARENA.height);
  const pos = vec2(wrapCoord(a.pos.x + dx * t, ARENA.width), wrapCoord(a.pos.y + dy * t, ARENA.height));
  const vel = vec2(a.vel.x + (b.vel.x - a.vel.x) * t, a.vel.y + (b.vel.y - a.vel.y) * t);
  const angle = lerpAngle(a.angle, b.angle, t);

  return {
    ...b,
    pos,
    vel,
    angle,
  };
}

export class EntityInterpolator {
  private readonly buffer: BufferedSnapshot[] = [];

  public reset(): void {
    this.buffer.length = 0;
  }

  public push(snapshot: SnapshotMessage, receivedAtMs: number): void {
    this.buffer.push({ receivedAtMs, snapshot });
    if (this.buffer.length > 32) {
      this.buffer.shift();
    }
  }

  public sample(nowMs: number, excludeShipId: EntityId | null): SnapshotEntity[] {
    const latestEntry = this.buffer[this.buffer.length - 1];
    if (!latestEntry) {
      return [];
    }

    const renderTime = nowMs - INTERPOLATION_DELAY_MS;

    while (this.buffer.length >= 3) {
      const second = this.buffer[1];
      if (second && second.receivedAtMs <= renderTime) {
        this.buffer.shift();
      } else {
        break;
      }
    }

    const first = this.buffer[0];
    const second = this.buffer[1];

    if (!first || !second || renderTime <= first.receivedAtMs) {
      return latestEntry.snapshot.entities.filter(
        (e) => !(e.kind === 'ship' && excludeShipId !== null && e.id === excludeShipId),
      );
    }

    if (renderTime >= second.receivedAtMs) {
      return second.snapshot.entities.filter(
        (e) => !(e.kind === 'ship' && excludeShipId !== null && e.id === excludeShipId),
      );
    }

    const span = Math.max(1, second.receivedAtMs - first.receivedAtMs);
    const alpha = Math.max(0, Math.min(1, (renderTime - first.receivedAtMs) / span));

    const prevMap = new Map<EntityId, SnapshotEntity>();
    for (const e of first.snapshot.entities) {
      prevMap.set(e.id, e);
    }

    const result: SnapshotEntity[] = [];
    for (const nextEnt of second.snapshot.entities) {
      if (nextEnt.kind === 'ship' && excludeShipId !== null && nextEnt.id === excludeShipId) {
        continue;
      }
      const prevEnt = prevMap.get(nextEnt.id);
      if (prevEnt && prevEnt.kind === nextEnt.kind) {
        result.push(interpolateEntity(prevEnt, nextEnt, alpha));
      } else {
        result.push(nextEnt);
      }
    }

    return result;
  }
}
