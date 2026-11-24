const TURN_SPEED = 4.2;
const THRUST_ACCEL = 320;
const LINEAR_DRAG = 0.985;
const MAX_SPEED = 450;

function wrap(value, max) {
  if (value < 0) return value + max;
  if (value >= max) return value - max;
  return value;
}

export function createShip(x, y) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, radius: 14 };
}

export function integrate(ship, input, dt, arena = { width: 900, height: 600 }) {
  const turnDir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const angle = ship.angle + turnDir * TURN_SPEED * dt;

  let vx = ship.vx;
  let vy = ship.vy;

  if (input.thrust) {
    vx += Math.cos(angle) * THRUST_ACCEL * dt;
    vy += Math.sin(angle) * THRUST_ACCEL * dt;
  }

  const damping = LINEAR_DRAG ** (dt * 60);
  vx *= damping;
  vy *= damping;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed;
    vx *= scale;
    vy *= scale;
  }

  const x = wrap(ship.x + vx * dt, arena.width);
  const y = wrap(ship.y + vy * dt, arena.height);

  return { ...ship, x, y, vx, vy, angle };
}
