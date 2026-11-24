import {
  FIXED_DT,
  TICK_RATE,
  addShipToWorld,
  buildSnapshotFromWorld,
  createWorldState,
  encodeSnapshotBinary,
  removeShipFromWorld,
  stepWorldState,
} from '@game/shared';

const TICK_INTERVAL_MS = 1000 / TICK_RATE;

export class AuthoritativeMatch {
  #world;
  #latestInputs = new Map();
  #nextShipId = 1;
  #timer = null;
  #running = false;
  #nextTickTarget = 0;
  #lastTickStart = 0;
  #stats = {
    tickRate: TICK_RATE,
    currentTick: 0,
    avgTickDurationMs: 0,
    maxTickDurationMs: 0,
    avgJitterMs: 0,
  };
  #onBroadcastTick;

  constructor({ seed, asteroidCount, homingRatio, onBroadcastTick }) {
    this.#world = createWorldState({ seed, asteroidCount, homingRatio });
    this.#onBroadcastTick = onBroadcastTick;
  }

  get seed() {
    return this.#world.seed;
  }

  getStats() {
    return {
      ...this.#stats,
      currentTick: this.#world.tick,
      ships: this.#world.ships.length,
      asteroids: this.#world.asteroids.length,
      bullets: this.#world.bullets.length,
    };
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    const now = performance.now();
    this.#nextTickTarget = now + TICK_INTERVAL_MS;
    this.#lastTickStart = now;
    this.#scheduleNext();
  }

  stop() {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  addPlayer(name) {
    const shipId = this.#nextShipId++;
    const slotIndex = this.#world.ships.length;
    addShipToWorld(this.#world, { id: shipId, name, slotIndex });
    this.#latestInputs.set(shipId, { seq: 0, thrust: false, turn: 0, fire: false, fireHoming: false });
    return shipId;
  }

  removePlayer(shipId) {
    removeShipFromWorld(this.#world, shipId);
    this.#latestInputs.delete(shipId);
  }

  queueInput(shipId, validatedInput) {
    const prev = this.#latestInputs.get(shipId);
    if (prev && validatedInput.seq <= prev.seq) return;
    // Зберігаємо натискання fire, щоб короткий клік не загубився між тіками
    const fire = Boolean(validatedInput.fire || prev?.pendingFire);
    const fireHoming = Boolean(validatedInput.fireHoming || prev?.pendingFireHoming);
    this.#latestInputs.set(shipId, {
      ...validatedInput,
      fire,
      fireHoming,
      pendingFire: false,
      pendingFireHoming: false,
    });
  }

  buildPersonalizedSnapshot(shipId, { binary = true } = {}) {
    const ship = this.#world.ships.find((s) => s.id === shipId);
    const snapshot = buildSnapshotFromWorld(this.#world, {
      yourShipId: shipId,
      lastProcessedSeq: ship?.lastProcessedSeq ?? 0,
      serverTimeMs: performance.now(),
    });
    if (binary) {
      return encodeSnapshotBinary(snapshot);
    }
    return JSON.stringify({ type: 'snapshot', ...snapshot });
  }

  #scheduleNext() {
    if (!this.#running) return;
    const delay = Math.max(0, this.#nextTickTarget - performance.now());
    this.#timer = setTimeout(() => this.#tick(), delay);
  }

  #tick() {
    if (!this.#running) return;
    const tStart = performance.now();
    const actualInterval = tStart - this.#lastTickStart;
    this.#lastTickStart = tStart;
    const jitter = Math.abs(actualInterval - TICK_INTERVAL_MS);

    const { events } = stepWorldState(this.#world, this.#latestInputs, FIXED_DT);

    // Скидаємо одноразові імпульси пострілів після кроку симуляції
    for (const input of this.#latestInputs.values()) {
      input.fire = false;
      input.fireHoming = false;
    }

    this.#onBroadcastTick?.(this, events);

    const duration = performance.now() - tStart;
    this.#stats.avgTickDurationMs = +(this.#stats.avgTickDurationMs * 0.9 + duration * 0.1).toFixed(3);
    this.#stats.maxTickDurationMs = +Math.max(this.#stats.maxTickDurationMs, duration).toFixed(3);
    this.#stats.avgJitterMs = +(this.#stats.avgJitterMs * 0.9 + jitter * 0.1).toFixed(3);

    // Абсолютне планування наступного кроку (без накопичення дрейфу setInterval)
    this.#nextTickTarget += TICK_INTERVAL_MS;
    if (this.#nextTickTarget < performance.now() - TICK_INTERVAL_MS) {
      this.#nextTickTarget = performance.now() + TICK_INTERVAL_MS;
    }
    this.#scheduleNext();
  }
}
