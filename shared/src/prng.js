export function createPrng(seed) {
  let state = seed >>> 0;
  return {
    get state() {
      return state >>> 0;
    },
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(min, max) {
      return min + (max - min) * this.next();
    },
  };
}

export function hashWorldState(world) {
  let h = 0x811c9dc5;
  const pushInt = (n) => {
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
    pushInt(s.x);
    pushInt(s.y);
    pushInt(s.vx);
    pushInt(s.vy);
    pushInt(s.angle * 1000);
    pushInt(s.hp);
    pushInt(s.score);
  }
  for (const a of world.asteroids) {
    pushInt(a.id);
    pushInt(a.x);
    pushInt(a.y);
    pushInt(a.vx);
    pushInt(a.vy);
  }
  for (const b of world.bullets) {
    pushInt(b.id);
    pushInt(b.x);
    pushInt(b.y);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
