import {
  ARENA,
  type AsteroidSnapshotEntity,
  type BulletSnapshotEntity,
  type EntityId,
  type ShipSnapshotEntity,
  type SnapshotEntity,
} from '@game/shared';
import type { Particle } from './particles.ts';

export class ArenaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to acquire 2D context for ArenaRenderer');
    }
    this.ctx = context;
  }

  public render(
    entities: readonly SnapshotEntity[],
    localShipId: EntityId | null,
    knownNames: ReadonlyMap<EntityId, string>,
    particles: readonly Particle[] = [],
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, ARENA.width, ARENA.height);

    this.drawGrid();
    this.drawParticles(particles);

    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i];
      if (!entity) continue;
      switch (entity.kind) {
        case 'asteroid':
          this.drawAsteroid(entity);
          break;
        case 'bullet':
          this.drawBullet(entity);
          break;
        case 'ship':
          this.drawShip(entity, localShipId !== null && entity.id === localShipId, knownNames);
          break;
        default: {
          const _exhaustive: never = entity;
          throw new Error(`Unhandled entity kind in renderer: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  }

  private drawParticles(particles: readonly Particle[]): void {
    const ctx = this.ctx;
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      if (!p || !p.active) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(30, 45, 71, 0.45)';
    ctx.lineWidth = 1;
    const step = 60;

    for (let x = step; x < ARENA.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA.height);
      ctx.stroke();
    }
    for (let y = step; y < ARENA.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA.width, y);
      ctx.stroke();
    }
  }

  private drawShip(
    ship: ShipSnapshotEntity,
    isLocal: boolean,
    knownNames: ReadonlyMap<EntityId, string>,
  ): void {
    if (!ship.alive) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.translate(ship.pos.x, ship.pos.y);
    ctx.rotate(ship.angle);

    if (ship.thrusting) {
      ctx.beginPath();
      ctx.moveTo(-14, -5);
      ctx.lineTo(-26, 0);
      ctx.lineTo(-14, 5);
      ctx.closePath();
      ctx.fillStyle = '#f97316';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-14, -11);
    ctx.lineTo(-9, 0);
    ctx.lineTo(-14, 11);
    ctx.closePath();
    ctx.fillStyle = isLocal ? '#38bdf8' : '#f43f5e';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#f8fafc';
    ctx.stroke();

    ctx.restore();

    const label = knownNames.get(ship.id) ?? ship.name;
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isLocal ? '#bae6fd' : '#fecdd3';
    ctx.fillText(`${label} (${ship.hp} HP)`, ship.pos.x, ship.pos.y - 22);
  }

  private drawAsteroid(ast: AsteroidSnapshotEntity): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(ast.pos.x, ast.pos.y);
    ctx.rotate(ast.angle);

    ctx.beginPath();
    const sides = 9;
    for (let i = 0; i < sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      const r = ast.radius * (i % 2 === 0 ? 1.0 : 0.82);
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = ast.homing ? 'rgba(245, 158, 11, 0.25)' : 'rgba(148, 163, 184, 0.2)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ast.homing ? '#f59e0b' : '#94a3b8';
    ctx.stroke();

    ctx.restore();
  }

  private drawBullet(bullet: BulletSnapshotEntity): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(bullet.pos.x, bullet.pos.y, bullet.homing ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = bullet.homing ? '#facc15' : '#4ade80';
    ctx.fill();
  }
}