import { describe, expect, it } from 'vitest';
import { ARENA } from '../../shared/src/index.ts';
import { ParticlePoolSystem } from '../src/particles.ts';

describe('ParticlePoolSystem (zero-allocation ObjectPool & Transferable buffer)', () => {
  it('preallocates full capacity and reuses particle instances without heap growth', () => {
    const sys = new ParticlePoolSystem(64);
    expect(sys.pool.createdCount).toBe(64);
    expect(sys.pool.freeCount).toBe(64);

    sys.emitExhaust(100, 100, 0);
    sys.emitExplosion(200, 200, 10);
    expect(sys.activeCount).toBe(11);
    expect(sys.pool.freeCount).toBe(53);
    expect(sys.pool.createdCount).toBe(64);

    // Advance past maxLife so all particles expire and return to pool
    sys.update(2.0);
    expect(sys.activeCount).toBe(0);
    expect(sys.pool.freeCount).toBe(64);
    expect(sys.pool.createdCount).toBe(64);
  });

  it('wraps particle positions inside arena bounds during update', () => {
    const sys = new ParticlePoolSystem(16);
    sys.emitExplosion(ARENA.width - 1, ARENA.height - 1, 4);
    sys.update(0.05);

    for (const p of sys.active) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(ARENA.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(ARENA.height);
    }
  });

  it('packs and unpacks active particles via Transferable Float32Array buffer', () => {
    const sys = new ParticlePoolSystem(32);
    sys.emitExplosion(300, 250, 5);
    expect(sys.activeCount).toBe(5);

    const buf = sys.packToTransferBuffer(0.05);
    const view = new Float32Array(buf);
    // Simulate worker stepping x += vx * dt and life -= dt
    const count = Math.floor(view[1] ?? 0);
    for (let i = 0; i < count; i += 1) {
      const base = 2 + i * 6;
      view[base] = 444;
      view[base + 4] = 0.2;
    }

    sys.applyFromTransferBuffer(buf);
    expect(sys.activeCount).toBe(5);
    expect(sys.active[0]?.x).toBe(444);

    // Simulate expiration via buffer
    for (let i = 0; i < count; i += 1) {
      const base = 2 + i * 6;
      view[base + 4] = -0.1;
    }
    sys.applyFromTransferBuffer(buf);
    expect(sys.activeCount).toBe(0);
    expect(sys.pool.freeCount).toBe(32);
  });

  it('resets all active particles back into the pool immediately', () => {
    const sys = new ParticlePoolSystem(20);
    sys.emitExplosion(150, 150, 12);
    expect(sys.activeCount).toBe(12);
    sys.reset();
    expect(sys.activeCount).toBe(0);
    expect(sys.pool.freeCount).toBe(20);
  });
});