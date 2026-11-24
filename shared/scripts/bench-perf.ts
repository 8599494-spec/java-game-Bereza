import { performance } from 'node:perf_hooks';
import {
  ARENA,
  FIXED_DT,
  type ShipControlInput,
  addShipToWorld,
  asEntityId,
  asRadians,
  asSeq,
  createWorldState,
  mutVec2,
  setVec2,
  stepWorldState,
  vec2,
  wrapDistance,
} from '../src/index.ts';

function runSimulationBench(ticks: number): { elapsedMs: number; heapDeltaKB: number; poolCreated: number } {
  const world = createWorldState({ seed: 2026, asteroidCount: 10, homingRatio: 0.3 });
  for (let i = 1; i <= 8; i += 1) {
    addShipToWorld(world, { id: asEntityId(i), name: `Bot-${i}`, slotIndex: i - 1 });
  }

  const inputs = new Map<ReturnType<typeof asEntityId>, ShipControlInput>();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  for (let t = 1; t <= ticks; t += 1) {
    inputs.clear();
    for (let i = 1; i <= 8; i += 1) {
      inputs.set(asEntityId(i), {
        seq: asSeq(t),
        thrust: true,
        turn: Math.sin(t * 0.05 + i),
        fire: t % 6 === 0,
        fireHoming: false,
      });
    }
    stepWorldState(world, inputs, FIXED_DT, ARENA);
  }

  const elapsedMs = performance.now() - t0;
  const heapAfter = process.memoryUsage().heapUsed;

  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    heapDeltaKB: Number(((heapAfter - heapBefore) / 1024).toFixed(1)),
    poolCreated: world.bulletPool.createdCount,
  };
}

function runUnpooledBaselineBench(ticks: number): { elapsedMs: number; heapDeltaKB: number } {
  const entities = Array.from({ length: 128 }, (_, i) => ({
    id: i,
    pos: vec2((i * 37) % ARENA.width, (i * 53) % ARENA.height),
    vel: vec2(Math.cos(i) * 120, Math.sin(i) * 120),
    angle: asRadians(0),
  }));

  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  let hits = 0;

  for (let t = 0; t < ticks; t += 1) {
    const transientBullets = Array.from({ length: 32 }, (_, b) => ({
      pos: vec2((b * 29 + t) % ARENA.width, (b * 41 + t) % ARENA.height),
      vel: vec2(300, 150),
    }));

    for (let i = 0; i < transientBullets.length; i += 1) {
      const b = transientBullets[i];
      if (!b) continue;
      for (let j = 0; j < entities.length; j += 1) {
        const e = entities[j];
        if (!e) continue;
        if (wrapDistance(b.pos, e.pos, ARENA) < 20) {
          hits += 1;
        }
      }
    }
    const scratch = mutVec2(0, 0);
    setVec2(scratch, hits, t);
  }

  const elapsedMs = performance.now() - t0;
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    heapDeltaKB: Number(((heapAfter - heapBefore) / 1024).toFixed(1)),
  };
}

runSimulationBench(500);
runUnpooledBaselineBench(500);

const baseline = runUnpooledBaselineBench(4000);
const optimized = runSimulationBench(4000);

console.log('=== Lab 07 V8 Engine & Memory Benchmark (4,000 ticks, 8 active bots) ===');
console.log(
  `Baseline (unpooled new + O(N^2)): ${baseline.elapsedMs} ms | Heap delta: ${baseline.heapDeltaKB} KB`,
);
console.log(
  `Optimized (ObjectPool + SpatialHash + MutVec2): ${optimized.elapsedMs} ms | Heap delta: ${optimized.heapDeltaKB} KB | Pool size: ${optimized.poolCreated}`,
);
