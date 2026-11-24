import { ARENA, ENTITY_KIND, normalizeAngle, shortestWrapDelta, wrapCoord } from '@game/shared';

function lerpWrap(a, b, t, max) {
  const delta = shortestWrapDelta(a, b, max);
  return wrapCoord(a + delta * t, max);
}

function lerpAngle(a, b, t) {
  const diff = normalizeAngle(b - a);
  return normalizeAngle(a + diff * t);
}

export class EntityInterpolator {
  #snapshots = [];
  #interpolationDelayMs = 100;

  get interpolationDelayMs() {
    return this.#interpolationDelayMs;
  }

  setInterpolationDelayMs(ms) {
    this.#interpolationDelayMs = Math.max(0, Math.min(300, Number(ms) || 0));
  }

  pushSnapshot(snapshot) {
    this.#snapshots.push({
      recvTime: performance.now(),
      snapshot,
    });
    while (this.#snapshots.length > 40) {
      this.#snapshots.shift();
    }
  }

  // Малюємо чужі кораблі, астероїди та чужі кулі трохи в минулому між двома знімками
  sampleEntities(excludeShipId) {
    if (this.#snapshots.length === 0) return [];

    const renderTime = performance.now() - this.#interpolationDelayMs;

    // Якщо буфер ще малий або затримка 0 — повертаємо останній знімок
    if (this.#snapshots.length === 1 || renderTime >= this.#snapshots.at(-1).recvTime) {
      return this.#snapshots
        .at(-1)
        .snapshot.entities.filter((e) => !(e.kind === ENTITY_KIND.SHIP && e.id === excludeShipId));
    }

    let older = this.#snapshots[0];
    let newer = this.#snapshots[1];
    for (let i = 0; i < this.#snapshots.length - 1; i += 1) {
      if (this.#snapshots[i].recvTime <= renderTime && this.#snapshots[i + 1].recvTime >= renderTime) {
        older = this.#snapshots[i];
        newer = this.#snapshots[i + 1];
        break;
      }
    }

    const span = Math.max(1, newer.recvTime - older.recvTime);
    const t = Math.max(0, Math.min(1, (renderTime - older.recvTime) / span));

    const olderMap = new Map(older.snapshot.entities.map((e) => [`${e.kind}:${e.id}`, e]));
    const result = [];

    for (const curr of newer.snapshot.entities) {
      if (curr.kind === ENTITY_KIND.SHIP && curr.id === excludeShipId) continue;

      const prev = olderMap.get(`${curr.kind}:${curr.id}`);
      if (!prev) {
        // Сутність щойно з'явилася в новому знімку
        result.push(curr);
        continue;
      }

      result.push({
        ...curr,
        x: lerpWrap(prev.x, curr.x, t, ARENA.width),
        y: lerpWrap(prev.y, curr.y, t, ARENA.height),
        angle: lerpAngle(prev.angle, curr.angle, t),
      });
    }

    return result;
  }
}
