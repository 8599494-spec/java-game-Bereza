import {
  FIXED_DT,
  addShipToWorld,
  buildSnapshotFromWorld,
  createWorldState,
  decodeBinaryPacket,
  encodeInputBinary,
  encodeSnapshotBinary,
  stepWorldState,
} from '../src/index.js';

// Моделюємо матч 30 Hz із 4 гравцями, 8 астероїдами та активними кулями
const world = createWorldState({ seed: 2026, asteroidCount: 8, homingRatio: 0.35 });
for (let i = 1; i <= 4; i += 1) {
  addShipToWorld(world, { id: i, name: `Pilot-${i}`, slotIndex: i - 1 });
}

const inputs = new Map();
for (let t = 0; t < 20; t += 1) {
  for (let i = 1; i <= 4; i += 1) {
    inputs.set(i, { seq: t + 1, thrust: true, turn: 0.25, fire: t % 5 === 0, fireHoming: false });
  }
  stepWorldState(world, inputs, FIXED_DT);
}

const sampleSnap = buildSnapshotFromWorld(world, {
  yourShipId: 1,
  lastProcessedSeq: 20,
  serverTimeMs: 666.6,
});
const sampleInput = { seq: 42, tick: 20, thrust: true, turn: -0.5, fire: true, fireHoming: false };

const encoder = new TextEncoder();
const jsonSnapStr = JSON.stringify({ type: 'snapshot', ...sampleSnap });
const jsonInputStr = JSON.stringify({ type: 'input', ...sampleInput });
const jsonSnapBytes = encoder.encode(jsonSnapStr).byteLength;
const jsonInputBytes = encoder.encode(jsonInputStr).byteLength;

const binSnapBuf = encodeSnapshotBinary(sampleSnap);
const binInputBuf = encodeInputBinary(sampleInput);
const binSnapBytes = binSnapBuf.byteLength;
const binInputBytes = binInputBuf.byteLength;

const ITERATIONS = 20_000;

const tJson0 = performance.now();
for (let i = 0; i < ITERATIONS; i += 1) {
  const s = JSON.stringify({ type: 'snapshot', ...sampleSnap });
  JSON.parse(s);
}
const jsonUs = ((performance.now() - tJson0) * 1000) / ITERATIONS;

const tBin0 = performance.now();
for (let i = 0; i < ITERATIONS; i += 1) {
  const b = encodeSnapshotBinary(sampleSnap);
  decodeBinaryPacket(b);
}
const binUs = ((performance.now() - tBin0) * 1000) / ITERATIONS;

console.table([
  {
    Codec: 'JSON',
    'Bytes/snapshot': jsonSnapBytes,
    'KB/s per client (down @30Hz)': +((jsonSnapBytes * 30) / 1024).toFixed(2),
    'KB/s per client (up @30Hz)': +((jsonInputBytes * 30) / 1024).toFixed(2),
    'Encode+decode (µs)': +jsonUs.toFixed(2),
  },
  {
    Codec: 'Binary (DataView)',
    'Bytes/snapshot': binSnapBytes,
    'KB/s per client (down @30Hz)': +((binSnapBytes * 30) / 1024).toFixed(2),
    'KB/s per client (up @30Hz)': +((binInputBytes * 30) / 1024).toFixed(2),
    'Encode+decode (µs)': +binUs.toFixed(2),
  },
]);
