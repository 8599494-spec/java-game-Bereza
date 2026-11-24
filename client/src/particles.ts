import { ARENA, ObjectPool, wrapCoord } from '@game/shared';

export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

const MAX_PARTICLES = 512;
export const FLOATS_PER_PARTICLE = 6;

function createParticle(): Particle {
  return {
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.3,
    size: 2,
    color: '#f97316',
  };
}

function resetParticle(p: Particle): void {
  p.x = 0;
  p.y = 0;
  p.vx = 0;
  p.vy = 0;
  p.life = 0;
  p.maxLife = 0.3;
  p.size = 2;
  p.color = '#f97316';
}

export class ParticlePoolSystem {
  public readonly pool: ObjectPool<Particle>;
  public readonly active: Particle[] = [];
  private rngSeed = 1234567;

  public constructor(capacity = MAX_PARTICLES) {
    this.pool = new ObjectPool<Particle>(createParticle, resetParticle, capacity);
  }

  private nextRand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 0x100000000;
  }

  public get activeCount(): number {
    return this.active.length;
  }

  public reset(): void {
    for (let i = 0; i < this.active.length; i += 1) {
      const p = this.active[i];
      if (p) this.pool.release(p);
    }
    this.active.length = 0;
  }

  public emitExhaust(x: number, y: number, shipAngle: number): void {
    if (this.active.length >= MAX_PARTICLES) return;
    const p = this.pool.acquire();
    const spread = (this.nextRand() - 0.5) * 0.6;
    const speed = 70 + this.nextRand() * 60;
    const backAngle = shipAngle + Math.PI + spread;

    p.x = wrapCoord(x - Math.cos(shipAngle) * 14, ARENA.width);
    p.y = wrapCoord(y - Math.sin(shipAngle) * 14, ARENA.height);
    p.vx = Math.cos(backAngle) * speed;
    p.vy = Math.sin(backAngle) * speed;
    p.maxLife = 0.22 + this.nextRand() * 0.12;
    p.life = p.maxLife;
    p.size = 2.2;
    p.color = '#fb923c';
    this.active.push(p);
  }

  public emitExplosion(x: number, y: number, count = 14, color = '#facc15'): void {
    for (let i = 0; i < count; i += 1) {
      if (this.active.length >= MAX_PARTICLES) break;
      const p = this.pool.acquire();
      const a = (i / count) * Math.PI * 2 + this.nextRand() * 0.3;
      const speed = 50 + this.nextRand() * 160;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxLife = 0.35 + this.nextRand() * 0.25;
      p.life = p.maxLife;
      p.size = 2.8;
      p.color = color;
      this.active.push(p);
    }
  }

  public update(dt: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.active.length; i += 1) {
      const p = this.active[i];
      if (!p) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.pool.release(p);
        continue;
      }
      p.x = wrapCoord(p.x + p.vx * dt, ARENA.width);
      p.y = wrapCoord(p.y + p.vy * dt, ARENA.height);
      this.active[writeIdx] = p;
      writeIdx += 1;
    }
    this.active.length = writeIdx;
  }

  public packToTransferBuffer(dt: number): ArrayBuffer {
    const count = this.active.length;
    const buf = new ArrayBuffer((2 + count * FLOATS_PER_PARTICLE) * 4);
    const view = new Float32Array(buf);
    view[0] = dt;
    view[1] = count;
    for (let i = 0; i < count; i += 1) {
      const p = this.active[i];
      if (!p) continue;
      const base = 2 + i * FLOATS_PER_PARTICLE;
      view[base] = p.x;
      view[base + 1] = p.y;
      view[base + 2] = p.vx;
      view[base + 3] = p.vy;
      view[base + 4] = p.life;
      view[base + 5] = p.maxLife;
    }
    return buf;
  }

  public applyFromTransferBuffer(buf: ArrayBuffer): void {
    const view = new Float32Array(buf);
    const count = Math.min(this.active.length, Math.floor(view[1] ?? 0));
    let writeIdx = 0;
    for (let i = 0; i < count; i += 1) {
      const p = this.active[i];
      if (!p) continue;
      const base = 2 + i * FLOATS_PER_PARTICLE;
      const life = view[base + 4] ?? 0;
      if (life <= 0) {
        this.pool.release(p);
        continue;
      }
      p.x = view[base] ?? p.x;
      p.y = view[base + 1] ?? p.y;
      p.life = life;
      this.active[writeIdx] = p;
      writeIdx += 1;
    }
    for (let i = count; i < this.active.length; i += 1) {
      const extra = this.active[i];
      if (extra) {
        this.active[writeIdx] = extra;
        writeIdx += 1;
      }
    }
    this.active.length = writeIdx;
  }
}
