import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIXED_DT,
  MSG_TYPE,
  addShipToWorld,
  buildSnapshotFromWorld,
  createWorldState,
  decodeBinaryPacket,
  encodeInputBinary,
  encodePingPongBinary,
  encodeSnapshotBinary,
  hashWorldState,
  setDeterminismBugEnabled,
  stepWorldState,
} from '../src/index.js';

test('shared simulation runs in pure Node without DOM and is deterministic', () => {
  assert.equal(typeof globalThis.document, 'undefined');

  const runSimulation = () => {
    const world = createWorldState({ seed: 424242, asteroidCount: 6, homingRatio: 0.3 });
    addShipToWorld(world, { id: 1, name: 'Alpha', slotIndex: 0 });
    addShipToWorld(world, { id: 2, name: 'Bravo', slotIndex: 1 });

    const inputs = new Map();
    for (let step = 0; step < 300; step += 1) {
      inputs.set(1, {
        seq: step + 1,
        thrust: step % 3 !== 0,
        turn: step % 40 < 20 ? 0.6 : -0.4,
        fire: step % 25 === 0,
        fireHoming: false,
      });
      inputs.set(2, {
        seq: step + 1,
        thrust: true,
        turn: -0.35,
        fire: step % 30 === 0,
        fireHoming: step % 90 === 0,
      });
      stepWorldState(world, inputs, FIXED_DT);
    }
    return hashWorldState(world);
  };

  setDeterminismBugEnabled(false);
  const hashA = runSimulation();
  const hashB = runSimulation();
  assert.equal(hashA, hashB);

  // Перевіряємо, що ін'єкція Math.random() ламає детермінізм
  setDeterminismBugEnabled(true);
  const brokenA = runSimulation();
  const brokenB = runSimulation();
  setDeterminismBugEnabled(false);
  assert.notEqual(brokenA, brokenB);
});

test('DataView binary codec round-trips INPUT, PING/PONG and SNAPSHOT accurately', () => {
  const input = { seq: 12345, tick: 999, thrust: true, turn: -0.75, fire: true, fireHoming: false };
  const decodedInput = decodeBinaryPacket(encodeInputBinary(input));
  assert.equal(decodedInput.seq, input.seq);
  assert.equal(decodedInput.tick, input.tick);
  assert.equal(decodedInput.thrust, true);
  assert.equal(decodedInput.fire, true);
  assert.equal(decodedInput.fireHoming, false);
  assert.ok(Math.abs(decodedInput.turn - input.turn) < 1e-5);

  const pingBuf = encodePingPongBinary(MSG_TYPE.PING, 123456.75);
  const decodedPing = decodeBinaryPacket(pingBuf);
  assert.equal(decodedPing.kind, 'ping');
  assert.equal(decodedPing.clientTimeMs, 123456.75);

  const world = createWorldState({ seed: 777, asteroidCount: 5, homingRatio: 0.4 });
  addShipToWorld(world, { id: 1, name: 'Pilot1', slotIndex: 0 });
  addShipToWorld(world, { id: 2, name: 'Pilot2', slotIndex: 1 });
  const snap = buildSnapshotFromWorld(world, { yourShipId: 1, lastProcessedSeq: 88, serverTimeMs: 4321.5 });

  const binBuf = encodeSnapshotBinary(snap);
  const decodedSnap = decodeBinaryPacket(binBuf);

  assert.equal(decodedSnap.tick, snap.tick);
  assert.equal(decodedSnap.lastProcessedSeq, 88);
  assert.equal(decodedSnap.yourShipId, 1);
  assert.equal(decodedSnap.entities.length, snap.entities.length);

  for (let i = 0; i < snap.entities.length; i += 1) {
    const orig = snap.entities[i];
    const dec = decodedSnap.entities[i];
    assert.equal(dec.id, orig.id);
    assert.equal(dec.kind, orig.kind);
    assert.ok(Math.abs(dec.x - orig.x) < 1e-3);
    assert.ok(Math.abs(dec.y - orig.y) < 1e-3);
    assert.ok(Math.abs(dec.angle - orig.angle) <= 0.0011);
  }
});
