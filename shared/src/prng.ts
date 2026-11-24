import type { EntityId, Radians, Tick, Vector2 } from './types.ts';

export interface Prng {
  readonly state: number;
  next(): number;
  range(min: number, max: number): number;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return {
    get state(): number {
      return state >>> 0;
    },
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(min: number, max: number): number {
      return min + (max - min) * this.next();
    },
  };
}

export interface HashableWorld {
  readonly tick: Tick;
  readonly rngState: number;
  readonly ships: ReadonlyArray<{
    readonly id: EntityId;
    readonly pos: Vector2;
    readonly vel: Vector2;
    readonly angle: Radians;
    readonly hp: number;
    readonly score: number;
  }>;
  readonly asteroids: ReadonlyArray<{
    readonly id: EntityId;
    readonly pos: Vector2;
    readonly vel: Vector2;
  }>;
  readonly bullets: ReadonlyArray<{
    readonly id: EntityId;
    readonly pos: Vector2;
  }>;
}

export function hashWorldState(world: HashableWorld): string {
  let h = 0x811c9dc5;
  const pushInt = (n: number): void => {
    const v = Math.round(n * 100) | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };

  pushInt(world.tick);
  pushInt(world.rngState);
  for (const s of world.ships) {
    pushInt(s.id);
    pushInt(s.pos.x);
    pushInt(s.pos.y);
    pushInt(s.vel.x);
    pushInt(s.vel.y);
    pushInt(s.angle * 1000);
    pushInt(s.hp);
    pushInt(s.score);
  }
  for (const a of world.asteroids) {
    pushInt(a.id);
    pushInt(a.pos.x);
    pushInt(a.pos.y);
    pushInt(a.vel.x);
    pushInt(a.vel.y);
  }
  for (const b of world.bullets) {
    pushInt(b.id);
    pushInt(b.pos.x);
    pushInt(b.pos.y);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
