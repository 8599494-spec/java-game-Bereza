import { createPrng } from './prng.js';
import { ENTITY_KIND, normalizeAngle } from './protocol.js';

export const ARENA = Object.freeze({ width: 900, height: 600 });
export const TICK_RATE = 30;
export const FIXED_DT = 1 / TICK_RATE;

const SHIP_RADIUS = 16;
const SHIP_ACCEL = 320;
const SHIP_TURN_SPEED = 3.8;
const SHIP_MAX_SPEED = 420;
const BULLET_SPEED = 560;
const BULLET_TTL = 1.35;

let brokenDeterminismEnabled = false;

export function setDeterminismBugEnabled(enabled) {
  brokenDeterminismEnabled = Boolean(enabled);
}

export function isDeterminismBugEnabled() {
  return brokenDeterminismEnabled;
}

export function wrapCoord(value, max) {
  let v = value % max;
  if (v < 0) v += max;
  return v;
}

export function shortestWrapDelta(from, to, max) {
  let d = to - from;
  if (d > max * 0.5) d -= max;
  if (d < -max * 0.5) d += max;
  return d;
}

export function wrapDistance(a, b, arena = ARENA) {
  const dx = shortestWrapDelta(a.x, b.x, arena.width);
  const dy = shortestWrapDelta(a.y, b.y, arena.height);
  return Math.hypot(dx, dy);
}

export function integrateShip(ship, input, dt = FIXED_DT, arena = ARENA) {
  if (!ship.alive) return ship;

  const turn = Math.max(-1, Math.min(1, Number(input?.turn) || 0));
  const thrust = Boolean(input?.thrust);

  ship.angle = normalizeAngle(ship.angle + turn * SHIP_TURN_SPEED * dt);
  ship.thrusting = thrust;

  if (thrust) {
    ship.vx += Math.cos(ship.angle) * SHIP_ACCEL * dt;
    ship.vy += Math.sin(ship.angle) * SHIP_ACCEL * dt;
  }

  if (brokenDeterminismEnabled) {
    ship.vx += (Math.random() - 0.5) * 140;
    ship.vy += (Math.random() - 0.5) * 140;
  }

  const drag = 0.985 ** (dt * 60);
  ship.vx *= drag;
  ship.vy *= drag;

  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > SHIP_MAX_SPEED) {
    const k = SHIP_MAX_SPEED / speed;
    ship.vx *= k;
    ship.vy *= k;
  }

  ship.x = wrapCoord(ship.x + ship.vx * dt, arena.width);
  ship.y = wrapCoord(ship.y + ship.vy * dt, arena.height);
  ship.fireCooldown = Math.max(0, (ship.fireCooldown ?? 0) - dt);
  ship.invulnTimer = Math.max(0, (ship.invulnTimer ?? 0) - dt);
  return ship;
}

function spawnAsteroidWithRng(state, rng, homingRatio, arena) {
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
  const angle = rng.range(-Math.PI, Math.PI);
  const speed = homing ? 125 : rng.range(70, 150);
  const id = state.nextEntityId++;

  return {
    id,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    angle,
    radius: homing ? 20 : 25,
    homing,
  };
}

export function createWorldState({ seed = 1337, asteroidCount = 6, homingRatio = 0.3, arena = ARENA } = {}) {
  const rng = createPrng(seed);
  const state = {
    tick: 0,
    seed: seed >>> 0,
    rngState: rng.state,
    asteroidCount,
    homingRatio,
    nextEntityId: 100,
    ships: [],
    asteroids: [],
    bullets: [],
  };

  for (let i = 0; i < asteroidCount; i += 1) {
    state.asteroids.push(spawnAsteroidWithRng(state, rng, homingRatio, arena));
  }
  state.rngState = rng.state;
  return state;
}

export function addShipToWorld(state, { id, name, slotIndex = 0, arena = ARENA }) {
  const spawns = [
    { x: arena.width * 0.28, y: arena.height * 0.5, angle: 0 },
    { x: arena.width * 0.72, y: arena.height * 0.5, angle: Math.PI },
    { x: arena.width * 0.5, y: arena.height * 0.25, angle: Math.PI * 0.5 },
    { x: arena.width * 0.5, y: arena.height * 0.75, angle: -Math.PI * 0.5 },
  ];
  const sp = spawns[slotIndex % spawns.length];
  const ship = {
    id,
    name: name || `Pilot-${id}`,
    slotIndex,
    x: sp.x,
    y: sp.y,
    vx: 0,
    vy: 0,
    angle: sp.angle,
    hp: 100,
    maxHp: 100,
    alive: true,
    thrusting: false,
    score: 0,
    fireCooldown: 0,
    invulnTimer: 1.5,
    respawnTimer: 0,
    lastProcessedSeq: 0,
  };
  state.ships.push(ship);
  return ship;
}

export function removeShipFromWorld(state, shipId) {
  state.ships = state.ships.filter((s) => s.id !== shipId);
}

export function stepWorldState(state, inputsByShipId, dt = FIXED_DT, arena = ARENA) {
  const rng = createPrng(state.rngState);
  const events = [];
  state.tick += 1;

  for (const ship of state.ships) {
    const input = inputsByShipId?.get?.(ship.id) ?? inputsByShipId?.[ship.id] ?? null;
    if (input && typeof input.seq === 'number') {
      ship.lastProcessedSeq = input.seq;
    }

    if (!ship.alive) {
      ship.respawnTimer = Math.max(0, ship.respawnTimer - dt);
      if (ship.respawnTimer <= 0) {
        ship.alive = true;
        ship.hp = ship.maxHp;
        ship.vx = 0;
        ship.vy = 0;
        ship.x = rng.range(120, arena.width - 120);
        ship.y = rng.range(100, arena.height - 100);
        ship.invulnTimer = 1.5;
      }
      continue;
    }

    integrateShip(ship, input, dt, arena);

    const wantsFire = Boolean(input?.fire || input?.fireHoming);
    if (wantsFire && ship.fireCooldown <= 0) {
      const isHoming = Boolean(input?.fireHoming);
      ship.fireCooldown = isHoming ? 0.42 : 0.2;
      const noseX = wrapCoord(ship.x + Math.cos(ship.angle) * (SHIP_RADIUS + 8), arena.width);
      const noseY = wrapCoord(ship.y + Math.sin(ship.angle) * (SHIP_RADIUS + 8), arena.height);
      state.bullets.push({
        id: state.nextEntityId++,
        ownerId: ship.id,
        x: noseX,
        y: noseY,
        vx: ship.vx * 0.35 + Math.cos(ship.angle) * BULLET_SPEED,
        vy: ship.vy * 0.35 + Math.sin(ship.angle) * BULLET_SPEED,
        angle: ship.angle,
        homing: isHoming,
        ttl: BULLET_TTL,
      });
      events.push({ type: 'fire', shipId: ship.id });
    }
  }

  for (const ast of state.asteroids) {
    if (ast.homing && state.ships.length > 0) {
      let nearest = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const s of state.ships) {
        if (!s.alive) continue;
        const d = wrapDistance(ast, s, arena);
        if (d < bestDist) {
          bestDist = d;
          nearest = s;
        }
      }
      if (nearest && bestDist > 1) {
        const dx = shortestWrapDelta(ast.x, nearest.x, arena.width);
        const dy = shortestWrapDelta(ast.y, nearest.y, arena.height);
        const desiredAngle = Math.atan2(dy, dx);
        const diff = normalizeAngle(desiredAngle - ast.angle);
        ast.angle = normalizeAngle(ast.angle + Math.max(-1.4 * dt, Math.min(1.4 * dt, diff)));
        const speed = Math.hypot(ast.vx, ast.vy);
        ast.vx = Math.cos(ast.angle) * speed;
        ast.vy = Math.sin(ast.angle) * speed;
      }
    }
    ast.x = wrapCoord(ast.x + ast.vx * dt, arena.width);
    ast.y = wrapCoord(ast.y + ast.vy * dt, arena.height);
  }

  const survivingBullets = [];
  const destroyedAsteroidIds = new Set();

  for (const b of state.bullets) {
    b.ttl -= dt;
    if (b.ttl <= 0) continue;

    if (b.homing) {
      let target = null;
      let bestDist = 340;
      for (const s of state.ships) {
        if (!s.alive || s.id === b.ownerId) continue;
        const d = wrapDistance(b, s, arena);
        if (d < bestDist) {
          bestDist = d;
          target = s;
        }
      }
      if (target) {
        const dx = shortestWrapDelta(b.x, target.x, arena.width);
        const dy = shortestWrapDelta(b.y, target.y, arena.height);
        const desired = Math.atan2(dy, dx);
        const diff = normalizeAngle(desired - b.angle);
        b.angle = normalizeAngle(b.angle + Math.max(-4.5 * dt, Math.min(4.5 * dt, diff)));
        b.vx = Math.cos(b.angle) * BULLET_SPEED;
        b.vy = Math.sin(b.angle) * BULLET_SPEED;
      }
    }

    b.x = wrapCoord(b.x + b.vx * dt, arena.width);
    b.y = wrapCoord(b.y + b.vy * dt, arena.height);

    let consumed = false;

    for (const s of state.ships) {
      if (!s.alive || s.id === b.ownerId || s.invulnTimer > 0) continue;
      if (wrapDistance(b, s, arena) <= SHIP_RADIUS + 5) {
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
    if (consumed) continue;

    for (const ast of state.asteroids) {
      if (destroyedAsteroidIds.has(ast.id)) continue;
      if (wrapDistance(b, ast, arena) <= ast.radius + 4) {
        consumed = true;
        destroyedAsteroidIds.add(ast.id);
        const shooter = state.ships.find((owner) => owner.id === b.ownerId);
        if (shooter) shooter.score += 25;
        events.push({ type: 'exploded', targetId: ast.id, score: 25 });
        break;
      }
    }

    if (!consumed) {
      survivingBullets.push(b);
    }
  }

  state.bullets = survivingBullets;

  for (const s of state.ships) {
    if (!s.alive || s.invulnTimer > 0) continue;
    for (const ast of state.asteroids) {
      if (destroyedAsteroidIds.has(ast.id)) continue;
      if (wrapDistance(s, ast, arena) <= SHIP_RADIUS + ast.radius - 3) {
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

export function buildSnapshotFromWorld(
  state,
  { yourShipId = 0, lastProcessedSeq = 0, serverTimeMs = 0 } = {},
) {
  const entities = [];

  for (const s of state.ships) {
    entities.push({
      id: s.id,
      kind: ENTITY_KIND.SHIP,
      alive: s.alive,
      special: s.thrusting,
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      angle: s.angle,
      extra: s.hp,
      name: s.name,
      score: s.score,
    });
  }

  for (const a of state.asteroids) {
    entities.push({
      id: a.id,
      kind: ENTITY_KIND.ASTEROID,
      alive: true,
      special: a.homing,
      x: a.x,
      y: a.y,
      vx: a.vx,
      vy: a.vy,
      angle: a.angle,
      extra: Math.round(a.radius),
    });
  }

  for (const b of state.bullets) {
    entities.push({
      id: b.id,
      kind: ENTITY_KIND.BULLET,
      alive: true,
      special: b.homing,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      angle: b.angle,
      extra: b.ownerId,
    });
  }

  return {
    kind: 'snapshot',
    tick: state.tick,
    lastProcessedSeq,
    yourShipId,
    serverTimeMs,
    entities,
  };
}
