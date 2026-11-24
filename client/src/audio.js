export function createAudioSystem(audioContext, buffers, eventBus) {
  let muted = false;

  const unlock = () => {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  };

  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });

  function playBuffer(name, { gain = 0.4, playbackRate = 1 } = {}) {
    if (muted || !buffers?.[name]) return;
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffers[name];
    source.playbackRate.value = playbackRate;
    const gainNode = audioContext.createGain();
    gainNode.gain.value = gain;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(0);
  }

  const onFired = (event) => {
    const isHoming = Boolean(event.detail?.homing);
    playBuffer('fire', {
      gain: isHoming ? 0.5 : 0.32,
      playbackRate: isHoming ? 0.72 : 0.95 + Math.random() * 0.14,
    });
  };

  const onHit = () => {
    playBuffer('hit', { gain: 0.45, playbackRate: 0.9 + Math.random() * 0.2 });
  };

  const onExploded = (event) => {
    const isShip = event.detail?.kind === 'ship';
    playBuffer('explosion', {
      gain: isShip ? 0.7 : 0.48,
      playbackRate: isShip ? 0.75 : 0.9 + Math.random() * 0.25,
    });
  };

  eventBus.addEventListener('fired', onFired);
  eventBus.addEventListener('hit', onHit);
  eventBus.addEventListener('exploded', onExploded);

  return {
    unlock,
    toggleMute() {
      muted = !muted;
      return muted;
    },
    isMuted() {
      return muted;
    },
    destroy() {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      eventBus.removeEventListener('fired', onFired);
      eventBus.removeEventListener('hit', onHit);
      eventBus.removeEventListener('exploded', onExploded);
    },
  };
}
