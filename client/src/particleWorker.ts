import { ARENA, wrapCoord } from '@game/shared';
import { FLOATS_PER_PARTICLE } from './particles.ts';

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!(data instanceof ArrayBuffer)) return;

  const view = new Float32Array(data);
  const dt = view[0] ?? 0;
  const count = Math.floor(view[1] ?? 0);

  for (let i = 0; i < count; i += 1) {
    const base = 2 + i * FLOATS_PER_PARTICLE;
    const life = (view[base + 4] ?? 0) - dt;
    view[base + 4] = life;
    if (life > 0) {
      const x = view[base] ?? 0;
      const y = view[base + 1] ?? 0;
      const vx = view[base + 2] ?? 0;
      const vy = view[base + 3] ?? 0;
      view[base] = wrapCoord(x + vx * dt, ARENA.width);
      view[base + 1] = wrapCoord(y + vy * dt, ARENA.height);
    }
  }

  Reflect.apply(globalThis.postMessage, globalThis, [data, [data]]);
});