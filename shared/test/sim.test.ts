import { describe, expect, it } from 'vitest';
import {
  addShipToWorld,
  addVec2,
  addVec2InPlace,
  ARENA,
  asEntityId,
  asRadians,
  asSeq,
  asTick,
  buildSnapshotFromWorld,
  createPrng,
  createWorldState,
  FIXED_DT,
  hashWorldState,
  integrateShip,
  isDeterminismBugEnabled,
  lenVec2,
  mutVec2,
  ObjectPool,
  removeShipFromWorld,
  SpatialHash,
  scaleVec2,
  scaleVec2InPlace,
  setDeterminismBugEnabled,
  setVec2,
  type ShipControlInput,
  shortestWrapDelta,
  stepWorldState,
  subVec2,
  TokenBucketRateLimiter,
  vec2,
  wrapCoord,
  wrapDistance,
  ZERO_VEC2,
} from '../src/index.ts';

describe('Vector2 math & in-place operations', () => {
  it('adds, subtracts, scales, and measures vector length accurately', () => {
    const a = vec2(3, 4);
    const b = vec2(1, -2);
    expect(lenVec2(ZERO_VEC2)).toBe(0);
    expect(lenVec2(a)).toBe(5);
    expect(addVec2(a, b)).toEqual({ x: 4, y: 2 });
    expect(subVec2(a, b)).toEqual({ x: 2, y: 6 });
    expect(scaleVec2(a, 2.5)).toEqual({ x: 7.5, y: 10 });
  });

  it('mutates MutVec2 in place without creating extra objects', () => {
    const m = mutVec2(2, 3);
    setVec2(m, 5, 6);
    expect(m).toEqual({ x: 5, y: 6 });
    addVec2InPlace(m, vec2(2, -1));
    expect(m).toEqual({ x: 7, y: 5 });
    scaleVec2InPlace(m, 2);
    expect(m).toEqual({ x: 14, y: 10 });
  });

  it('computes toroidal wrap coordinates and shortest wrap delta', () => {
    expect(wrapCoord(-15, 900)).toBe(885);
    expect(wrapCoord(925, 900)).toBe(25);
    expect(shortestWrapDelta(890, 10, 900)).toBe(20);
    expect(shortestWrapDelta(10, 890, 900)).toBe(-20);
    expect(wrapDistance(vec2(895, 10), vec2(5, 10), ARENA)).toBe(10);
  });
});

describe('integrateShip physics', () => {
  it('accelerates forward when thrust is active and clamps at max speed', () => {
    const world = createWorldState({ seed: 1, asteroidCount: 0 });
    const ship = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    const startX = ship.pos.x;

    integrateShip(ship, { thrust: true, turn: 0 }, FIXED_DT, ARENA);
    expect(ship.vel.x).toBeGreaterThan(0);
    expect(ship.pos.x).toBeGreaterThan(startX);
    expect(ship.thrusting).toBe(true);

    for (let i = 0; i < 300; i += 1) {
      integrateShip(ship, { thrust: true, turn: 0 }, FIXED_DT, ARENA);
    }
    expect(lenVec2(ship.vel)).toBeLessThanOrEqual(420.0001);
  });

  it('rotates ship angle according to turn input and wraps coordinates at edges', () => {
    const world = createWorldState({ seed: 2, asteroidCount: 0 });
    const ship = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    ship.angle = asRadians(0);
    integrateShip(ship, { thrust: false, turn: 1 }, 0.5, ARENA);
    expect(ship.angle).toBeCloseTo(1.9, 5);

    setVec2(ship.pos, 898, 599);
    setVec2(ship.vel, 120, 90);
    integrateShip(ship, { thrust: false, turn: 0 }, 0.1, ARENA);
    expect(ship.pos.x).toBeGreaterThanOrEqual(0);
    expect(ship.pos.x).toBeLessThan(ARENA.width);
    expect(ship.pos.y).toBeGreaterThanOrEqual(0);
    expect(ship.pos.y).toBeLessThan(ARENA.height);
  });

  it('does not move dead ships during integrateShip', () => {
    const world = createWorldState({ seed: 3, asteroidCount: 0 });
    const ship = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    ship.alive = false;
    const before = { x: ship.pos.x, y: ship.pos.y };
    integrateShip(ship, { thrust: true, turn: 1 }, FIXED_DT, ARENA);
    expect(ship.pos).toEqual(before);
  });
});

describe('Collisions, bullet pool, and SpatialHash', () => {
  it('detects bullet-ship hit, reduces HP, awards score on kill, and recycles bullet to pool', () => {
    const world = createWorldState({ seed: 10, asteroidCount: 0 });
    const shooter = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    const target = addShipToWorld(world, { id: asEntityId(2), slotIndex: 1 });
    target.invulnTimer = 0;
    target.hp = 20;

    setVec2(shooter.pos, 200, 300);
    shooter.angle = asRadians(0);
    setVec2(target.pos, 232, 300);

    const { events } = stepWorldState(
      world,
      new Map([[shooter.id, { seq: asSeq(1), fire: true }]]),
      FIXED_DT,
      ARENA,
    );

    expect(events.some((e) => e.type === 'hit' && e.targetId === target.id)).toBe(true);
    expect(events.some((e) => e.type === 'exploded' && e.targetId === target.id)).toBe(true);
    expect(target.alive).toBe(false);
    expect(shooter.score).toBe(100);
    expect(world.bullets.length).toBe(0);
    expect(world.bulletPool.freeCount).toBe(128);
  });

  it('detects bullet-asteroid collision and respawns asteroid count', () => {
    const world = createWorldState({ seed: 11, asteroidCount: 1, homingRatio: 0 });
    const shooter = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    const ast = world.asteroids[0];
    expect(ast).toBeDefined();
    if (!ast) return;

    setVec2(shooter.pos, 300, 300);
    shooter.angle = asRadians(0);
    setVec2(ast.pos, 336, 300);
    setVec2(ast.vel, 0, 0);

    const { events } = stepWorldState(
      world,
      new Map([[shooter.id, { seq: asSeq(1), fire: true }]]),
      FIXED_DT,
      ARENA,
    );

    expect(events.some((e) => e.type === 'exploded' && e.targetId === ast.id)).toBe(true);
    expect(shooter.score).toBe(25);
    expect(world.asteroids.length).toBe(1);
  });

  it('handles ship-asteroid collision with damage and temporary invulnerability', () => {
    const world = createWorldState({ seed: 12, asteroidCount: 1, homingRatio: 0 });
    const ship = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });
    ship.invulnTimer = 0;
    const ast = world.asteroids[0];
    expect(ast).toBeDefined();
    if (!ast) return;

    setVec2(ast.pos, ship.pos.x + 10, ship.pos.y);
    stepWorldState(world, new Map(), FIXED_DT, ARENA);

    expect(ship.hp).toBe(65);
    expect(ship.invulnTimer).toBeGreaterThan(0);
  });

  it('ObjectPool recycles released items without growing createdCount', () => {
    const pool = new ObjectPool(
      () => ({ active: false, value: 0 }),
      (item) => {
        item.value = 0;
      },
      2,
    );
    expect(pool.createdCount).toBe(2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.freeCount).toBe(0);
    pool.release(a);
    pool.release(b);
    expect(pool.freeCount).toBe(2);
    const c = pool.acquire();
    expect(c).toBe(b);
    expect(pool.createdCount).toBe(2);
  });

  it('SpatialHash finds nearby entities across wrapped arena borders', () => {
    const grid = new SpatialHash<{ id: number }>(900, 600, 100);
    const edgeItem = { id: 42 };
    grid.insert(vec2(895, 595), edgeItem);
    const found = grid.queryRadius(vec2(5, 5), 25, []);
    expect(found).toContain(edgeItem);
    grid.clear();
    expect(grid.queryRadius(vec2(5, 5), 25, [])).toHaveLength(0);
  });
});

describe('Simulation determinism & snapshot building', () => {
  it('produces identical state hashes across 300 ticks with identical seed and inputs', () => {
    const runSim = (): string => {
      const world = createWorldState({ seed: 424242, asteroidCount: 6, homingRatio: 0.3 });
      const ship1 = addShipToWorld(world, { id: asEntityId(1), name: 'Alpha', slotIndex: 0 });
      const ship2 = addShipToWorld(world, { id: asEntityId(2), name: 'Bravo', slotIndex: 1 });

      for (let t = 1; t <= 300; t += 1) {
        const inputs = new Map<typeof ship1.id, ShipControlInput>();
        inputs.set(ship1.id, {
          seq: asSeq(t),
          thrust: t % 3 !== 0,
          turn: Math.sin(t * 0.05),
          fire: t % 15 === 0,
        });
        inputs.set(ship2.id, {
          seq: asSeq(t),
          thrust: t % 2 === 0,
          turn: Math.cos(t * 0.04),
          fireHoming: t % 25 === 0,
        });
        stepWorldState(world, inputs);
      }

      return hashWorldState(world);
    };

    expect(runSim()).toBe(runSim());
  });

  it('diverges when determinism bug flag is enabled and restores cleanly', () => {
    const w1 = createWorldState({ seed: 777, asteroidCount: 2 });
    const w2 = createWorldState({ seed: 777, asteroidCount: 2 });
    addShipToWorld(w1, { id: asEntityId(1) });
    addShipToWorld(w2, { id: asEntityId(1) });

    setDeterminismBugEnabled(true);
    expect(isDeterminismBugEnabled()).toBe(true);
    stepWorldState(w1, new Map([[asEntityId(1), { thrust: true }]]));
    setDeterminismBugEnabled(false);
    stepWorldState(w2, new Map([[asEntityId(1), { thrust: true }]]));

    expect(hashWorldState(w1)).not.toBe(hashWorldState(w2));
  });

  it('builds snapshots and handles ship respawn and removal', () => {
    const world = createWorldState({ seed: 55, asteroidCount: 2 });
    const ship = addShipToWorld(world, { id: asEntityId(9), name: 'Nova' });
    ship.alive = false;
    ship.respawnTimer = 0.01;

    stepWorldState(world, new Map(), FIXED_DT);
    expect(ship.alive).toBe(true);

    const snap = buildSnapshotFromWorld(world, {
      yourShipId: ship.id,
      lastProcessedSeq: asSeq(4),
      serverTimeMs: 500,
    });
    expect(snap.tick).toBe(asTick(1));
    expect(snap.entities.some((e) => e.kind === 'ship' && e.id === ship.id)).toBe(true);

    removeShipFromWorld(world, ship.id);
    expect(world.ships).toHaveLength(0);
  });

  it('PRNG generates bounded deterministic sequences', () => {
    const a = createPrng(999);
    const b = createPrng(999);
    for (let i = 0; i < 20; i += 1) {
      const va = a.range(-10, 10);
      const vb = b.range(-10, 10);
      expect(va).toBe(vb);
      expect(va).toBeGreaterThanOrEqual(-10);
      expect(va).toBeLessThanOrEqual(10);
    }
  });
});

describe('TokenBucketRateLimiter', () => {
  it('enforces burst capacity and refills over time', () => {
    const limiter = new TokenBucketRateLimiter(3, 10, 1000);
    expect(limiter.tryConsume(1000)).toBe(true);
    expect(limiter.tryConsume(1000)).toBe(true);
    expect(limiter.tryConsume(1000)).toBe(true);
    expect(limiter.tryConsume(1000)).toBe(false);

    // After 200ms at 10 tokens/s -> 2 tokens refilled
    expect(limiter.tryConsume(1200)).toBe(true);
    expect(limiter.tryConsume(1200)).toBe(true);
    expect(limiter.tryConsume(1200)).toBe(false);
    expect(limiter.availableTokens).toBeCloseTo(0, 5);
  });
});