import { ObjectPool } from './pool.ts';
import { type Prng, createPrng } from './prng.ts';
import { type SnapshotEntity, type SnapshotMessage, normalizeAngle } from './protocol.ts';
import { SpatialHash } from './spatialHash.ts';
import {
  type EntityId,
  type MutVec2,
  type Radians,
  type Seq,
  type Tick,
  type Vector2,
  asEntityId,
  asRadians,
  asSeq,
  asTick,
  mutVec2,
  setVec2,
} from './types.ts';

export interface ArenaBounds {
  readonly width: number;
  readonly height: number;
}

export const ARENA: ArenaBounds = Object.freeze({ width: 900, height: 600 });
export const TICK_RATE = 30;
export const FIXED_DT = 1 / TICK_RATE;

const SHIP_RADIUS = 16;
const SHIP_ACCEL = 320;
const SHIP_TURN_SPEED = 3.8;
const SHIP_MAX_SPEED = 420;
const BULLET_SPEED = 560;
const BULLET_TTL = 1.35;

let brokenDeterminismEnabled = false;

export function setDeterminismBugEnabled(enabled: boolean): void {
  brokenDeterminismEnabled = Boolean(enabled);
}

export function isDeterminismBugEnabled(): boolean {
  return brokenDeterminismEnabled;
}

export function wrapCoord(value: number, max: number): number {
  let v = value % max;
  if (v < 0) v += max;
  return v;
}

export function shortestWrapDelta(from: number, to: number, max: number): number {
  let d = to - from;
  if (d > max * 0.5) d -= max;
  if (d < -max * 0.5) d += max;
  return d;
}

export function wrapDistance(a: Vector2, b: Vector2, arena: ArenaBounds = ARENA): number {
  const dx = shortestWrapDelta(a.x, b.x, arena.width);
  const dy = shortestWrapDelta(a.y, b.y, arena.height);
  return Math.hypot(dx, dy);
}

export interface ShipControlInput {
  readonly seq?: Seq;
  readonly thrust?: boolean;
  readonly turn?: number;
  readonly fire?: boolean;
  readonly fireHoming?: boolean;
}

export interface SimShip {
  readonly id: EntityId;
  name: string;
  readonly slotIndex: number;
  readonly pos: MutVec2;
  readonly vel: MutVec2;
  angle: Radians;
  hp: number;
  readonly maxHp: number;
  alive: boolean;
  thrusting: boolean;
  score: number;
  fireCooldown: number;
  invulnTimer: number;
  respawnTimer: number;
  lastProcessedSeq: Seq;
}

export interface SimAsteroid {
  readonly id: EntityId;
  readonly pos: MutVec2;
  readonly vel: MutVec2;
  angle: Radians;
  readonly radius: number;
  readonly homing: boolean;
}

export interface SimBullet {
  active: boolean;
  id: EntityId;
  ownerId: EntityId;
  readonly pos: MutVec2;
  readonly vel: MutVec2;
  angle: Radians;
  homing: boolean;
  ttl: number;
}

export interface WorldState {
  tick: Tick;
  readonly seed: number;
  rngState: number;
  readonly asteroidCount: number;
  readonly homingRatio: number;
  nextEntityId: number;
  ships: SimShip[];
  asteroids: SimAsteroid[];
  bullets: SimBullet[];
  readonly bulletPool: ObjectPool<SimBullet>;
  readonly asteroidGrid: SpatialHash<SimAsteroid>;
  readonly shipGrid: SpatialHash<SimShip>;
}

export type SimEvent =
  | { readonly type: 'fire'; readonly shipId: EntityId }
  | { readonly type: 'hit'; readonly targetId: EntityId }
  | { readonly type: 'exploded'; readonly targetId: EntityId; readonly score: number };

function createBlankBullet(): SimBullet {
  return {
    active: false,
    id: asEntityId(0),
    ownerId: asEntityId(0),
    pos: mutVec2(0, 0),
    vel: mutVec2(0, 0),
    angle: asRadians(0),
    homing: false,
    ttl: 0,
  };
}

function resetBullet(b: SimBullet): void {
  b.id = asEntityId(0);
  b.ownerId = asEntityId(0);
  setVec2(b.pos, 0, 0);
  setVec2(b.vel, 0, 0);
  b.angle = asRadians(0);
  b.homing = false;
  b.ttl = 0;
}

export function integrateShip(
  ship: SimShip,
  input: ShipControlInput | null | undefined,
  dt: number = FIXED_DT,
  arena: ArenaBounds = ARENA,
): SimShip {
  if (!ship.alive) return ship;

  const turn = Math.max(-1, Math.min(1, Number(input?.turn) || 0));
  const thrust = Boolean(input?.thrust);

  ship.angle = normalizeAngle(ship.angle + turn * SHIP_TURN_SPEED * dt);
  ship.thrusting = thrust;

  let vx = ship.vel.x;
  let vy = ship.vel.y;

  if (thrust) {
    vx += Math.cos(ship.angle) * SHIP_ACCEL * dt;
    vy += Math.sin(ship.angle) * SHIP_ACCEL * dt;
  }

  if (brokenDeterminismEnabled) {
    vx += (Math.random() - 0.5) * 140;
    vy += (Math.random() - 0.5) * 140;
  }

  const drag = 0.985 ** (dt * 60);
  vx *= drag;
  vy *= drag;

  const speed = Math.hypot(vx, vy);
  if (speed > SHIP_MAX_SPEED) {
    const k = SHIP_MAX_SPEED / speed;
    vx *= k;
    vy *= k;
  }

  setVec2(ship.vel, vx, vy);
  setVec2(
    ship.pos,
    wrapCoord(ship.pos.x + vx * dt, arena.width),
    wrapCoord(ship.pos.y + vy * dt, arena.height),
  );
  ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
  ship.invulnTimer = Math.max(0, ship.invulnTimer - dt);
  return ship;
}

function spawnAsteroidWithRng(
  state: WorldState,
  rng: Prng,
  homingRatio: number,
  arena: ArenaBounds,
): SimAsteroid {
  const edge = Math.floor(rng.next() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) {
    x = rng.range(0, arena.width);
    y = 0;
  } else if (edge === 1) {
    x = arena.width;
    y = rng.range(0, arena.height);
  } else if (edge === 2) {
    x = rng.range(0, arena.width);
    y = arena.height;
  } else {
    x = 0;
    y = rng.range(0, arena.height);
  }

  const homing = rng.next() < homingRatio;
  const angle = asRadians(rng.range(-Math.PI, Math.PI));
  const speed = homing ? 125 : rng.range(70, 150);
  const id = asEntityId(state.nextEntityId++);

  return {
    id,
    pos: mutVec2(x, y),
    vel: mutVec2(Math.cos(angle) * speed, Math.sin(angle) * speed),
    angle,
    radius: homing ? 20 : 25,
    homing,
  };
}

export interface CreateWorldOptions {
  readonly seed?: number;
  readonly asteroidCount?: number;
  readonly homingRatio?: number;
  readonly arena?: ArenaBounds;
}

export function createWorldState({
  seed = 1337,
  asteroidCount = 6,
  homingRatio = 0.3,
  arena = ARENA,
}: CreateWorldOptions = {}): WorldState {
  const rng = createPrng(seed);
  const bulletPool = new ObjectPool<SimBullet>(createBlankBullet, resetBullet, 128);
  const state: WorldState = {
    tick: asTick(0),
    seed: seed >>> 0,
    rngState: rng.state,
    asteroidCount,
    homingRatio,
    nextEntityId: 100,
    ships: [],
    asteroids: [],
    bullets: [],
    bulletPool,
    asteroidGrid: new SpatialHash<SimAsteroid>(arena.width, arena.height, 90),
    shipGrid: new SpatialHash<SimShip>(arena.width, arena.height, 90),
  };

  for (let i = 0; i < asteroidCount; i += 1) {
    state.asteroids.push(spawnAsteroidWithRng(state, rng, homingRatio, arena));
  }
  state.rngState = rng.state;
  return state;
}

export interface AddShipOptions {
  readonly id: EntityId;
  readonly name?: string;
  readonly slotIndex?: number;
  readonly arena?: ArenaBounds;
}

export function addShipToWorld(
  state: WorldState,
  { id, name, slotIndex = 0, arena = ARENA }: AddShipOptions,
): SimShip {
  const spawns: readonly { readonly x: number; readonly y: number; readonly angle: number }[] = [
    { x: arena.width * 0.28, y: arena.height * 0.5, angle: 0 },
    { x: arena.width * 0.72, y: arena.height * 0.5, angle: Math.PI },
    { x: arena.width * 0.5, y: arena.height * 0.25, angle: Math.PI * 0.5 },
    { x: arena.width * 0.5, y: arena.height * 0.75, angle: -Math.PI * 0.5 },
  ];
  const sp = spawns[slotIndex % spawns.length] ?? { x: arena.width * 0.5, y: arena.height * 0.5, angle: 0 };
  const ship: SimShip = {
    id,
    name: name || `Pilot-${id}`,
    slotIndex,
    pos: mutVec2(sp.x, sp.y),
    vel: mutVec2(0, 0),
    angle: asRadians(sp.angle),
    hp: 100,
    maxHp: 100,
    alive: true,
    thrusting: false,
    score: 0,
    fireCooldown: 0,
    invulnTimer: 1.5,
    respawnTimer: 0,
    lastProcessedSeq: asSeq(0),
  };
  state.ships.push(ship);
  return ship;
}

export function removeShipFromWorld(state: WorldState, shipId: EntityId): void {
  state.ships = state.ships.filter((s) => s.id !== shipId);
}

const nearbyShipsScratch: SimShip[] = [];
const nearbyAsteroidsScratch: SimAsteroid[] = [];

export function stepWorldState(
  state: WorldState,
  inputsByShipId: ReadonlyMap<EntityId, ShipControlInput> | null | undefined,
  dt: number = FIXED_DT,
  arena: ArenaBounds = ARENA,
): { readonly state: WorldState; readonly events: readonly SimEvent[] } {
  const rng = createPrng(state.rngState);
  const events: SimEvent[] = [];
  state.tick = asTick(state.tick + 1);

  for (let i = 0; i < state.ships.length; i += 1) {
    const ship = state.ships[i];
    if (!ship) continue;

    const input = inputsByShipId?.get(ship.id) ?? null;
    if (input?.seq !== undefined) {
      ship.lastProcessedSeq = input.seq;
    }

    if (!ship.alive) {
      ship.respawnTimer = Math.max(0, ship.respawnTimer - dt);
      if (ship.respawnTimer <= 0) {
        ship.alive = true;
        ship.hp = ship.maxHp;
        setVec2(ship.vel, 0, 0);
        setVec2(ship.pos, rng.range(120, arena.width - 120), rng.range(100, arena.height - 100));
        ship.invulnTimer = 1.5;
      }
      continue;
    }

    integrateShip(ship, input, dt, arena);

    const wantsFire = Boolean(input?.fire || input?.fireHoming);
    if (wantsFire && ship.fireCooldown <= 0) {
      const isHoming = Boolean(input?.fireHoming);
      ship.fireCooldown = isHoming ? 0.42 : 0.2;
      const noseX = wrapCoord(ship.pos.x + Math.cos(ship.angle) * (SHIP_RADIUS + 8), arena.width);
      const noseY = wrapCoord(ship.pos.y + Math.sin(ship.angle) * (SHIP_RADIUS + 8), arena.height);

      const bullet = state.bulletPool.acquire();
      bullet.id = asEntityId(state.nextEntityId++);
      bullet.ownerId = ship.id;
      setVec2(bullet.pos, noseX, noseY);
      setVec2(
        bullet.vel,
        ship.vel.x * 0.35 + Math.cos(ship.angle) * BULLET_SPEED,
        ship.vel.y * 0.35 + Math.sin(ship.angle) * BULLET_SPEED,
      );
      bullet.angle = ship.angle;
      bullet.homing = isHoming;
      bullet.ttl = BULLET_TTL;
      state.bullets.push(bullet);
      events.push({ type: 'fire', shipId: ship.id });
    }
  }

  for (let i = 0; i < state.asteroids.length; i += 1) {
    const ast = state.asteroids[i];
    if (!ast) continue;

    if (ast.homing && state.ships.length > 0) {
      let nearest: SimShip | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let j = 0; j < state.ships.length; j += 1) {
        const s = state.ships[j];
        if (!s || !s.alive) continue;
        const d = wrapDistance(ast.pos, s.pos, arena);
        if (d < bestDist) {
          bestDist = d;
          nearest = s;
        }
      }
      if (nearest && bestDist > 1) {
        const dx = shortestWrapDelta(ast.pos.x, nearest.pos.x, arena.width);
        const dy = shortestWrapDelta(ast.pos.y, nearest.pos.y, arena.height);
        const desiredAngle = Math.atan2(dy, dx);
        const diff = normalizeAngle(desiredAngle - ast.angle);
        ast.angle = normalizeAngle(ast.angle + Math.max(-1.4 * dt, Math.min(1.4 * dt, diff)));
        const speed = Math.hypot(ast.vel.x, ast.vel.y);
        setVec2(ast.vel, Math.cos(ast.angle) * speed, Math.sin(ast.angle) * speed);
      }
    }
    setVec2(
      ast.pos,
      wrapCoord(ast.pos.x + ast.vel.x * dt, arena.width),
      wrapCoord(ast.pos.y + ast.vel.y * dt, arena.height),
    );
  }

  // Rebuild spatial hash grids once per tick (zero allocation)
  state.shipGrid.clear();
  for (let i = 0; i < state.ships.length; i += 1) {
    const s = state.ships[i];
    if (s && s.alive) {
      state.shipGrid.insert(s.pos, s);
    }
  }

  state.asteroidGrid.clear();
  for (let i = 0; i < state.asteroids.length; i += 1) {
    const a = state.asteroids[i];
    if (a) {
      state.asteroidGrid.insert(a.pos, a);
    }
  }

  const destroyedAsteroidIds = new Set<EntityId>();
  let writeIdx = 0;

  for (let i = 0; i < state.bullets.length; i += 1) {
    const b = state.bullets[i];
    if (!b) continue;

    b.ttl -= dt;
    if (b.ttl <= 0) {
      state.bulletPool.release(b);
      continue;
    }

    if (b.homing) {
      let target: SimShip | null = null;
      let bestDist = 340;
      for (let j = 0; j < state.ships.length; j += 1) {
        const s = state.ships[j];
        if (!s || !s.alive || s.id === b.ownerId) continue;
        const d = wrapDistance(b.pos, s.pos, arena);
        if (d < bestDist) {
          bestDist = d;
          target = s;
        }
      }
      if (target) {
        const dx = shortestWrapDelta(b.pos.x, target.pos.x, arena.width);
        const dy = shortestWrapDelta(b.pos.y, target.pos.y, arena.height);
        const desired = Math.atan2(dy, dx);
        const diff = normalizeAngle(desired - b.angle);
        b.angle = normalizeAngle(b.angle + Math.max(-4.5 * dt, Math.min(4.5 * dt, diff)));
        setVec2(b.vel, Math.cos(b.angle) * BULLET_SPEED, Math.sin(b.angle) * BULLET_SPEED);
      }
    }

    setVec2(
      b.pos,
      wrapCoord(b.pos.x + b.vel.x * dt, arena.width),
      wrapCoord(b.pos.y + b.vel.y * dt, arena.height),
    );

    let consumed = false;

    const candidateShips = state.shipGrid.queryRadius(b.pos, SHIP_RADIUS + 8, nearbyShipsScratch);
    for (let j = 0; j < candidateShips.length; j += 1) {
      const s = candidateShips[j];
      if (!s || !s.alive || s.id === b.ownerId || s.invulnTimer > 0) continue;
      if (wrapDistance(b.pos, s.pos, arena) <= SHIP_RADIUS + 5) {
        consumed = true;
        s.hp = Math.max(0, s.hp - (b.homing ? 30 : 20));
        events.push({ type: 'hit', targetId: s.id });
        if (s.hp <= 0) {
          s.alive = false;
          s.respawnTimer = 2.0;
          const shooter = state.ships.find((owner) => owner.id === b.ownerId);
          if (shooter) shooter.score += 100;
          events.push({ type: 'exploded', targetId: s.id, score: 100 });
        }
        break;
      }
    }

    if (!consumed) {
      const candidateAsteroids = state.asteroidGrid.queryRadius(b.pos, 32, nearbyAsteroidsScratch);
      for (let j = 0; j < candidateAsteroids.length; j += 1) {
        const ast = candidateAsteroids[j];
        if (!ast || destroyedAsteroidIds.has(ast.id)) continue;
        if (wrapDistance(b.pos, ast.pos, arena) <= ast.radius + 4) {
          consumed = true;
          destroyedAsteroidIds.add(ast.id);
          const shooter = state.ships.find((owner) => owner.id === b.ownerId);
          if (shooter) shooter.score += 25;
          events.push({ type: 'exploded', targetId: ast.id, score: 25 });
          break;
        }
      }
    }

    if (consumed) {
      state.bulletPool.release(b);
    } else {
      state.bullets[writeIdx] = b;
      writeIdx += 1;
    }
  }
  state.bullets.length = writeIdx;

  for (let i = 0; i < state.ships.length; i += 1) {
    const s = state.ships[i];
    if (!s || !s.alive || s.invulnTimer > 0) continue;
    const candidateAsteroids = state.asteroidGrid.queryRadius(
      s.pos,
      SHIP_RADIUS + 30,
      nearbyAsteroidsScratch,
    );
    for (let j = 0; j < candidateAsteroids.length; j += 1) {
      const ast = candidateAsteroids[j];
      if (!ast || destroyedAsteroidIds.has(ast.id)) continue;
      if (wrapDistance(s.pos, ast.pos, arena) <= SHIP_RADIUS + ast.radius - 3) {
        destroyedAsteroidIds.add(ast.id);
        s.hp = Math.max(0, s.hp - 35);
        s.invulnTimer = 0.6;
        events.push({ type: 'hit', targetId: s.id });
        if (s.hp <= 0) {
          s.alive = false;
          s.respawnTimer = 2.0;
          events.push({ type: 'exploded', targetId: s.id, score: 0 });
        }
      }
    }
  }

  if (destroyedAsteroidIds.size > 0) {
    state.asteroids = state.asteroids.filter((a) => !destroyedAsteroidIds.has(a.id));
  }
  while (state.asteroids.length < state.asteroidCount) {
    state.asteroids.push(spawnAsteroidWithRng(state, rng, state.homingRatio, arena));
  }

  state.rngState = rng.state;
  return { state, events };
}

export interface BuildSnapshotOptions {
  readonly yourShipId: EntityId;
  readonly lastProcessedSeq: Seq;
  readonly serverTimeMs: number;
}

export function buildSnapshotFromWorld(
  state: WorldState,
  { yourShipId, lastProcessedSeq, serverTimeMs }: BuildSnapshotOptions,
): SnapshotMessage {
  const entities: SnapshotEntity[] = [];

  for (const s of state.ships) {
    entities.push({
      kind: 'ship',
      id: s.id,
      pos: { x: s.pos.x, y: s.pos.y },
      vel: { x: s.vel.x, y: s.vel.y },
      angle: s.angle,
      alive: s.alive,
      thrusting: s.thrusting,
      hp: s.hp,
      score: s.score,
      name: s.name,
    });
  }

  for (const a of state.asteroids) {
    entities.push({
      kind: 'asteroid',
      id: a.id,
      pos: { x: a.pos.x, y: a.pos.y },
      vel: { x: a.vel.x, y: a.vel.y },
      angle: a.angle,
      radius: a.radius,
      homing: a.homing,
    });
  }

  for (const b of state.bullets) {
    entities.push({
      kind: 'bullet',
      id: b.id,
      pos: { x: b.pos.x, y: b.pos.y },
      vel: { x: b.vel.x, y: b.vel.y },
      angle: b.angle,
      ownerId: b.ownerId,
      homing: b.homing,
    });
  }

  return {
    type: 'snapshot',
    tick: state.tick,
    lastProcessedSeq,
    yourShipId,
    serverTimeMs,
    entities,
  };
}
