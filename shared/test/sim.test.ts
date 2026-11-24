import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ShipControlInput,
  addShipToWorld,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  buildSnapshotFromWorld,
  createWorldState,
  hashWorldState,
  jsonCodec,
  parseClientMessage,
  stepWorldState,
} from '../src/index.ts';

test('deterministic simulation produces identical state hashes across 300 ticks', () => {
  const runSim = (): string => {
    const world = createWorldState({ seed: 424242, asteroidCount: 6, homingRatio: 0.3 });
    const ship1 = addShipToWorld(world, { id: asEntityId(1), name: 'Alpha', slotIndex: 0 });
    const ship2 = addShipToWorld(world, { id: asEntityId(2), name: 'Bravo', slotIndex: 1 });

    for (let t = 1; t <= 300; t += 1) {
      const inputs = new Map<typeof ship1.id, ShipControlInput>();
      inputs.set(ship1.id, {
        seq: asSeq(t),
        thrust: t % 3 !== 0,
        turn: Math.sin(t * 0.05),
        fire: t % 15 === 0,
      });
      inputs.set(ship2.id, {
        seq: asSeq(t),
        thrust: t % 2 === 0,
        turn: Math.cos(t * 0.04),
        fire: t % 20 === 0,
      });
      stepWorldState(world, inputs);
    }

    return hashWorldState(world);
  };

  const hashA = runSim();
  const hashB = runSim();
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 8);
});

test('zod protocol parser validates valid input and rejects malformed packets safely', () => {
  const valid = parseClientMessage({
    type: 'input',
    seq: 12,
    tick: 100,
    thrust: true,
    turn: 0.5,
    fire: false,
  });
  assert.equal(valid.ok, true);
  if (valid.ok && valid.value.type === 'input') {
    assert.equal(valid.value.seq, asSeq(12));
    assert.equal(valid.value.turn, 0.5);
  }

  const cheatTurn = parseClientMessage({
    type: 'input',
    seq: 13,
    tick: 101,
    thrust: true,
    turn: 1e9,
    fire: false,
  });
  assert.equal(cheatTurn.ok, false);

  const garbage = parseClientMessage('not-an-object');
  assert.equal(garbage.ok, false);
});

test('binary codec encodes/decodes snapshots and rejects corrupted packets', () => {
  const world = createWorldState({ seed: 99, asteroidCount: 4 });
  const ship = addShipToWorld(world, { id: asEntityId(7), name: 'Viper', slotIndex: 0 });
  stepWorldState(world, new Map([[ship.id, { seq: asSeq(5), thrust: true, turn: -0.25, fire: true }]]));

  const snapshot = buildSnapshotFromWorld(world, {
    yourShipId: ship.id,
    lastProcessedSeq: asSeq(5),
    serverTimeMs: 1234.5,
  });

  const encoded = binaryCodec.encodeServer(snapshot);
  assert.ok(encoded instanceof ArrayBuffer);

  const decoded = binaryCodec.decodeServer(encoded);
  assert.equal(decoded.ok, true);
  if (decoded.ok && decoded.value.type === 'snapshot') {
    assert.equal(decoded.value.tick, asTick(1));
    assert.equal(decoded.value.lastProcessedSeq, asSeq(5));
    assert.equal(decoded.value.yourShipId, asEntityId(7));
    assert.equal(decoded.value.entities.length, snapshot.entities.length);
  }

  const jsonEncoded = jsonCodec.encodeServer(snapshot);
  assert.equal(typeof jsonEncoded, 'string');
  assert.ok(encoded.byteLength < jsonEncoded.length);

  // Corrupted version byte must return ok: false instead of throwing
  const badBuf = encoded.slice(0);
  new Uint8Array(badBuf)[0] = 99;
  const badDecoded = binaryCodec.decodeServer(badBuf);
  assert.equal(badDecoded.ok, false);
});
