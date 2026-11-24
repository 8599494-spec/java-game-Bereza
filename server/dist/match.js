import { FIXED_DT, TICK_RATE, addShipToWorld, asSeq, buildSnapshotFromWorld, createWorldState, removeShipFromWorld, stepWorldState, } from '@game/shared';
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx] ?? 0;
}
export class AuthoritativeMatch {
    world;
    pendingInputs = new Map();
    latestInputs = new Map();
    bots = new Map();
    onSnapshot;
    tickDurationsMs = [];
    running = false;
    timer = null;
    nextTickTargetMs = 0;
    constructor(seed, onSnapshot) {
        this.world = createWorldState({ seed, asteroidCount: 6, homingRatio: 0.3 });
        this.onSnapshot = onSnapshot;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.nextTickTargetMs = performance.now() + 1000 / TICK_RATE;
        this.scheduleNextTick();
    }
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    get isRunning() {
        return this.running;
    }
    get botCount() {
        return this.bots.size;
    }
    addPlayer(shipId, name) {
        const slotIndex = this.world.ships.length;
        addShipToWorld(this.world, { id: shipId, name, slotIndex });
        this.pendingInputs.set(shipId, []);
    }
    addBot(bot) {
        this.addPlayer(bot.shipId, bot.name);
        this.bots.set(bot.shipId, bot);
    }
    removePlayer(shipId) {
        removeShipFromWorld(this.world, shipId);
        this.pendingInputs.delete(shipId);
        this.latestInputs.delete(shipId);
        this.bots.delete(shipId);
    }
    removeAllBots() {
        const ids = Array.from(this.bots.keys());
        for (const id of ids) {
            this.removePlayer(id);
        }
        return ids;
    }
    queueInput(shipId, input) {
        const queue = this.pendingInputs.get(shipId);
        if (!queue)
            return;
        if (queue.length >= 32) {
            queue.shift();
        }
        queue.push(input);
    }
    createSnapshotFor(shipId) {
        const ship = this.world.ships.find((s) => s.id === shipId);
        const lastProcessedSeq = ship ? ship.lastProcessedSeq : asSeq(0);
        return buildSnapshotFromWorld(this.world, {
            yourShipId: shipId,
            lastProcessedSeq,
            serverTimeMs: performance.now(),
        });
    }
    getTickStats() {
        if (this.tickDurationsMs.length === 0) {
            return { p50Ms: 0, p95Ms: 0, p99Ms: 0, sampleCount: 0 };
        }
        const sorted = [...this.tickDurationsMs].sort((a, b) => a - b);
        return {
            p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
            p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
            p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
            sampleCount: sorted.length,
        };
    }
    stepOnce() {
        this.stepTick();
    }
    scheduleNextTick() {
        if (!this.running)
            return;
        const intervalMs = 1000 / TICK_RATE;
        const now = performance.now();
        const delayMs = Math.max(0, this.nextTickTargetMs - now);
        this.timer = setTimeout(() => {
            if (!this.running)
                return;
            this.stepTick();
            this.nextTickTargetMs += intervalMs;
            const drift = performance.now() - this.nextTickTargetMs;
            if (drift > intervalMs * 3) {
                this.nextTickTargetMs = performance.now() + intervalMs;
            }
            this.scheduleNextTick();
        }, delayMs);
    }
    stepTick() {
        const t0 = performance.now();
        // Bots generate standard InputMessage using the exact same input queue as human players
        for (const bot of this.bots.values()) {
            const botInput = bot.computeInput(this.world, this.world.tick);
            this.queueInput(bot.shipId, botInput);
        }
        const stepInputs = new Map();
        for (const ship of this.world.ships) {
            const queue = this.pendingInputs.get(ship.id);
            const nextInput = queue?.shift();
            if (nextInput) {
                this.latestInputs.set(ship.id, nextInput);
                stepInputs.set(ship.id, nextInput);
            }
            else {
                const held = this.latestInputs.get(ship.id);
                if (held) {
                    stepInputs.set(ship.id, {
                        seq: held.seq,
                        thrust: held.thrust,
                        turn: held.turn,
                        fire: false,
                        fireHoming: false,
                    });
                }
            }
        }
        stepWorldState(this.world, stepInputs, FIXED_DT);
        for (const ship of this.world.ships) {
            if (this.bots.has(ship.id))
                continue;
            const snapshot = this.createSnapshotFor(ship.id);
            this.onSnapshot(ship.id, snapshot);
        }
        const elapsedMs = performance.now() - t0;
        this.tickDurationsMs.push(elapsedMs);
        if (this.tickDurationsMs.length > 600) {
            this.tickDurationsMs.shift();
        }
    }
}
