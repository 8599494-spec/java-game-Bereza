export function createLoop({ step, render, onStats, fixedStep = 1 / 60 }) {
  let rafId = null;
  let lastTime = 0;
  let accumulator = 0;

  let statsTimer = 0;
  let stepCount = 0;
  let frameCount = 0;
  let frameTimeAccum = 0;

  function frame(now) {
    rafId = requestAnimationFrame(frame);

    const rawDelta = (now - lastTime) / 1000;
    const frameDelta = Math.min(rawDelta, 0.25);
    lastTime = now;

    accumulator += frameDelta;

    const workStart = performance.now();

    while (accumulator >= fixedStep) {
      step(fixedStep);
      accumulator -= fixedStep;
      stepCount++;
    }

    const alpha = accumulator / fixedStep;
    render(alpha);

    const workDuration = performance.now() - workStart;

    frameCount++;
    frameTimeAccum += workDuration;
    statsTimer += rawDelta;

    if (statsTimer >= 1) {
      onStats?.({
        stepsPerSec: Math.round(stepCount / statsTimer),
        framesPerSec: Math.round(frameCount / statsTimer),
        frameTimeMs: (frameTimeAccum / frameCount).toFixed(2),
      });
      statsTimer = 0;
      stepCount = 0;
      frameCount = 0;
      frameTimeAccum = 0;
    }
  }

  return {
    start() {
      if (rafId !== null) return;
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}
