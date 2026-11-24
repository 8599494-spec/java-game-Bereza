import { ARENA, ENTITY_KIND, FIXED_DT, integrateShip, shortestWrapDelta, wrapCoord } from '@game/shared';

export class LocalShipPredictor {
  #shipId = 0;
  #predictionEnabled = true;
  #pendingInputs = [];
  #nextSeq = 1;
  #lastSnapshotTime = 0;
  #lastCorrectionPx = 0;
  #visualOffset = { x: 0, y: 0 };

  #state = {
    id: 0,
    x: ARENA.width * 0.5,
    y: ARENA.height * 0.5,
    vx: 0,
    vy: 0,
    angle: 0,
    hp: 100,
    alive: true,
    thrusting: false,
    score: 0,
  };

  get pendingCount() {
    return this.#pendingInputs.length;
  }

  get lastCorrectionPx() {
    return this.#lastCorrectionPx;
  }

  get snapshotAgeMs() {
    if (!this.#lastSnapshotTime) return 0;
    return Math.max(0, performance.now() - this.#lastSnapshotTime);
  }

  get predictionEnabled() {
    return this.#predictionEnabled;
  }

  setPredictionEnabled(enabled) {
    this.#predictionEnabled = Boolean(enabled);
    if (!this.#predictionEnabled) {
      this.#pendingInputs.length = 0;
      this.#visualOffset.x = 0;
      this.#visualOffset.y = 0;
    }
  }

  setShipId(shipId) {
    this.#shipId = shipId;
    this.#state.id = shipId;
  }

  // Створює input з seq, передбачає свій корабель одразу і повертає пакет для сервера
  stepLocalInput(rawControl, tick) {
    const input = {
      seq: this.#nextSeq++,
      tick,
      thrust: Boolean(rawControl.thrust),
      turn: (rawControl.right ? 1 : 0) - (rawControl.left ? 1 : 0),
      fire: Boolean(rawControl.fire),
      fireHoming: Boolean(rawControl.fireHoming),
    };

    if (this.#predictionEnabled) {
      this.#pendingInputs.push(input);
      if (this.#pendingInputs.length > 180) {
        this.#pendingInputs.shift();
      }
      integrateShip(this.#state, input, FIXED_DT, ARENA);
    }

    return input;
  }

  // Звірка зі знімком сервера (Server Reconciliation) + повтор непідтверджених input
  reconcile(snapshot) {
    this.#lastSnapshotTime = performance.now();
    const myId = snapshot.yourShipId || this.#shipId;
    if (myId) this.#shipId = myId;

    const serverShip = snapshot.entities.find((e) => e.kind === ENTITY_KIND.SHIP && e.id === this.#shipId);
    if (!serverShip) return;

    const beforeX = this.#state.x;
    const beforeY = this.#state.y;

    this.#state.id = serverShip.id;
    this.#state.x = serverShip.x;
    this.#state.y = serverShip.y;
    this.#state.vx = serverShip.vx;
    this.#state.vy = serverShip.vy;
    this.#state.angle = serverShip.angle;
    this.#state.hp = serverShip.extra;
    this.#state.alive = serverShip.alive;
    this.#state.thrusting = serverShip.special;
    if (typeof serverShip.score === 'number') {
      this.#state.score = serverShip.score;
    }

    // Відкидаємо вже підтверджені сервером input (seq <= lastProcessedSeq)
    while (this.#pendingInputs.length > 0 && this.#pendingInputs[0].seq <= snapshot.lastProcessedSeq) {
      this.#pendingInputs.shift();
    }

    if (!this.#predictionEnabled) {
      this.#lastCorrectionPx = 0;
      this.#visualOffset.x = 0;
      this.#visualOffset.y = 0;
      return;
    }

    // Повторно програємо залишок непідтверджених input поверх стану сервера
    for (const unacked of this.#pendingInputs) {
      integrateShip(this.#state, unacked, FIXED_DT, ARENA);
    }

    const dx = shortestWrapDelta(this.#state.x, beforeX, ARENA.width);
    const dy = shortestWrapDelta(this.#state.y, beforeY, ARENA.height);
    const err = Math.hypot(dx, dy);
    this.#lastCorrectionPx = err;

    // Згладжування поправки за ~100 мс (якщо не телепортація респавну)
    if (err > 0.25 && err < 180) {
      this.#visualOffset.x = dx;
      this.#visualOffset.y = dy;
    } else if (err >= 180) {
      this.#visualOffset.x = 0;
      this.#visualOffset.y = 0;
    }
  }

  decaySmoothing(renderDt) {
    const k = Math.exp(-renderDt / 0.035);
    this.#visualOffset.x *= k;
    this.#visualOffset.y *= k;
    if (Math.hypot(this.#visualOffset.x, this.#visualOffset.y) < 0.05) {
      this.#visualOffset.x = 0;
      this.#visualOffset.y = 0;
    }
  }

  getRenderShip() {
    return {
      ...this.#state,
      x: wrapCoord(this.#state.x + this.#visualOffset.x, ARENA.width),
      y: wrapCoord(this.#state.y + this.#visualOffset.y, ARENA.height),
    };
  }
}
