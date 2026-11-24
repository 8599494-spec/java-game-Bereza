import {
  ARENA,
  asSeq,
  type EntityId,
  type InputMessage,
  normalizeAngle,
  type SimShip,
  shortestWrapDelta,
  type Tick,
  type WorldState,
  wrapDistance,
} from '@game/shared';

export class BotController {
  public readonly shipId: EntityId;
  public readonly name: string;
  private seqCounter = 0;

  public constructor(shipId: EntityId, name: string) {
    this.shipId = shipId;
    this.name = name;
  }

  public computeInput(world: WorldState, currentTick: Tick): InputMessage {
    this.seqCounter += 1;
    const seq = asSeq(this.seqCounter);

    const me = world.ships.find((s) => s.id === this.shipId);
    if (!me || !me.alive) {
      return {
        type: 'input',
        seq,
        tick: currentTick,
        thrust: false,
        turn: 0,
        fire: false,
        fireHoming: false,
      };
    }

    // 1. Check immediate asteroid danger to evade
    let threatDx = 0;
    let threatDy = 0;
    let hasThreat = false;
    for (let i = 0; i < world.asteroids.length; i += 1) {
      const ast = world.asteroids[i];
      if (!ast) continue;
      const dist = wrapDistance(me.pos, ast.pos, ARENA);
      if (dist < ast.radius + 75) {
        threatDx -= shortestWrapDelta(me.pos.x, ast.pos.x, ARENA.width);
        threatDy -= shortestWrapDelta(me.pos.y, ast.pos.y, ARENA.height);
        hasThreat = true;
      }
    }

    if (hasThreat) {
      const escapeAngle = Math.atan2(threatDy, threatDx);
      const diff = normalizeAngle(escapeAngle - me.angle);
      const turn = Math.max(-1, Math.min(1, diff * 2.5));
      return {
        type: 'input',
        seq,
        tick: currentTick,
        thrust: true,
        turn,
        fire: false,
        fireHoming: false,
      };
    }

    // 2. Find nearest enemy ship or asteroid target
    let target: SimShip | null = null;
    let bestShipDist = Infinity;
    for (let i = 0; i < world.ships.length; i += 1) {
      const candidate = world.ships[i];
      if (!candidate || !candidate.alive || candidate.id === this.shipId) continue;
      const d = wrapDistance(me.pos, candidate.pos, ARENA);
      if (d < bestShipDist) {
        bestShipDist = d;
        target = candidate;
      }
    }

    let targetX = ARENA.width * 0.5;
    let targetY = ARENA.height * 0.5;
    let targetDist = Infinity;

    if (target) {
      targetX = target.pos.x;
      targetY = target.pos.y;
      targetDist = bestShipDist;
    } else {
      for (let i = 0; i < world.asteroids.length; i += 1) {
        const ast = world.asteroids[i];
        if (!ast) continue;
        const d = wrapDistance(me.pos, ast.pos, ARENA);
        if (d < targetDist) {
          targetDist = d;
          targetX = ast.pos.x;
          targetY = ast.pos.y;
        }
      }
    }

    const dx = shortestWrapDelta(me.pos.x, targetX, ARENA.width);
    const dy = shortestWrapDelta(me.pos.y, targetY, ARENA.height);
    const desiredAngle = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(desiredAngle - me.angle);

    const turn = Math.max(-1, Math.min(1, angleDiff * 2.2));
    const thrust = targetDist > 140 && Math.abs(angleDiff) < 1.1;
    const aligned = Math.abs(angleDiff) < 0.24 && targetDist < 460;
    const fireHoming = aligned && target !== null && targetDist > 240 && this.seqCounter % 15 === 0;

    return {
      type: 'input',
      seq,
      tick: currentTick,
      thrust,
      turn,
      fire: aligned && !fireHoming,
      fireHoming,
    };
  }
}