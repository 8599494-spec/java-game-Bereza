import { performance } from 'node:perf_hooks';
import {
  addShipToWorld,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  buildSnapshotFromWorld,
  createWorldState,
  jsonCodec,
  stepWorldState,
} from '../src/index.ts';

const world = createWorldState({ seed: 2026, asteroidCount: 8, homingRatio: 0.35 });
for (let i = 1; i <= 4; i += 1) {
  addShipToWorld(world, { id: asEntityId(i), name: `Player-${i}`, slotIndex: i - 1 });
}

for (let t = 0; t < 20; t += 1) {
  const inputs = new Map(
    world.ships.map((s) => [s.id, { seq: asSeq(t + 1), thrust: true, turn: 0.2, fire: t % 4 === 0 }]),
  );
  stepWorldState(world, inputs);
}

const snapshot = buildSnapshotFromWorld(world, {
  yourShipId: asEntityId(1),
  lastProcessedSeq: asSeq(20),
  serverTimeMs: 666.67,
});

const sampleInput = {
  type: 'input' as const,
  seq: asSeq(21),
  tick: asTick(20),
  thrust: true,
  turn: -0.5,
  fire: true,
  fireHoming: false,
};

const ITERATIONS = 20_000;

const t0 = performance.now();
let jsonSnapBytes = 0;
for (let i = 0; i < ITERATIONS; i += 1) {
  const raw = jsonCodec.encodeServer(snapshot);
  jsonSnapBytes = Buffer.byteLength(raw);
  jsonCodec.decodeServer(raw);
}
const jsonTotalUs = ((performance.now() - t0) * 1000) / ITERATIONS;

const t1 = performance.now();
let binSnapBytes = 0;
for (let i = 0; i < ITERATIONS; i += 1) {
  const raw = binaryCodec.encodeServer(snapshot);
  if (raw instanceof ArrayBuffer) {
    binSnapBytes = raw.byteLength;
  }
  binaryCodec.decodeServer(raw);
}
const binTotalUs = ((performance.now() - t1) * 1000) / ITERATIONS;

const jsonInBytes = Buffer.byteLength(jsonCodec.encodeClient(sampleInput));
const binInRaw = binaryCodec.encodeClient(sampleInput);
const binInBytes = binInRaw instanceof ArrayBuffer ? binInRaw.byteLength : Buffer.byteLength(binInRaw);

console.log(
  '| Codec | Bytes/snapshot | KB/s per client (down, 30Hz) | KB/s per client (up, 30Hz) | Encode+decode µs |',
);
console.log('| :--- | :---: | :---: | :---: | :---: |');
console.log(
  `| **JSON** | ${jsonSnapBytes} B | ${((jsonSnapBytes * 30) / 1024).toFixed(2)} KB/s | ${((jsonInBytes * 30) / 1024).toFixed(2)} KB/s | ${jsonTotalUs.toFixed(2)} µs |`,
);
console.log(
  `| **Binary (DataView)** | ${binSnapBytes} B | ${((binSnapBytes * 30) / 1024).toFixed(2)} KB/s | ${((binInBytes * 30) / 1024).toFixed(2)} KB/s | ${binTotalUs.toFixed(2)} µs |`,
);
