import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addShipToWorld,
  ARENA,
  asEntityId,
  asRadians,
  asSeq,
  asTick,
  binaryCodec,
  createWorldState,
  decodeSnapshotBinary,
  encodeSnapshotBinary,
  FIXED_DT,
  getCodec,
  hashWorldState,
  jsonCodec,
  normalizeAngle,
  parseClientMessage,
  parseServerMessage,
  type SnapshotEntity,
  type SnapshotMessage,
  stepWorldState,
  vec2,
} from '../src/index.ts';

const finiteCoordArb = fc.float({ min: 0, max: 900, noNaN: true });
const finiteVelArb = fc.float({ min: -500, max: 500, noNaN: true });
const angleArb = fc
  .float({ min: Math.fround(-Math.PI), max: Math.fround(Math.PI), noNaN: true })
  .map(asRadians);
const entityIdArb = fc.integer({ min: 1, max: 65000 }).map(asEntityId);

const snapshotEntityArb: fc.Arbitrary<SnapshotEntity> = fc.oneof(
  fc.record({
    kind: fc.constant('ship' as const),
    id: entityIdArb,
    pos: fc.record({ x: finiteCoordArb, y: finiteCoordArb }),
    vel: fc.record({ x: finiteVelArb, y: finiteVelArb }),
    angle: angleArb,
    alive: fc.boolean(),
    thrusting: fc.boolean(),
    hp: fc.integer({ min: 0, max: 100 }),
    score: fc.constant(0),
    name: fc.constant('Pilot-1'),
  }),
  fc.record({
    kind: fc.constant('asteroid' as const),
    id: entityIdArb,
    pos: fc.record({ x: finiteCoordArb, y: finiteCoordArb }),
    vel: fc.record({ x: finiteVelArb, y: finiteVelArb }),
    angle: angleArb,
    radius: fc.integer({ min: 5, max: 60 }),
    homing: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('bullet' as const),
    id: entityIdArb,
    pos: fc.record({ x: finiteCoordArb, y: finiteCoordArb }),
    vel: fc.record({ x: finiteVelArb, y: finiteVelArb }),
    angle: angleArb,
    ownerId: entityIdArb,
    homing: fc.boolean(),
  }),
);

const snapshotMessageArb: fc.Arbitrary<SnapshotMessage> = fc.record({
  type: fc.constant('snapshot' as const),
  tick: fc.integer({ min: 0, max: 1_000_000 }).map(asTick),
  lastProcessedSeq: fc.integer({ min: 0, max: 1_000_000 }).map(asSeq),
  yourShipId: entityIdArb,
  serverTimeMs: fc.float({ min: 0, max: 1_000_000, noNaN: true }),
  entities: fc.array(snapshotEntityArb, { minLength: 0, maxLength: 24 }),
});

describe('Property-based tests (fast-check)', () => {
  it('Property 1: Binary snapshot round-trip preserves fields within Int16 angle quantization tolerance', () => {
    fc.assert(
      fc.property(snapshotMessageArb, (snap) => {
        const encoded = encodeSnapshotBinary(snap);
        const decoded = decodeSnapshotBinary(encoded);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;

        expect(decoded.value.tick).toBe(snap.tick);
        expect(decoded.value.lastProcessedSeq).toBe(snap.lastProcessedSeq);
        expect(decoded.value.yourShipId).toBe(snap.yourShipId);
        expect(decoded.value.entities.length).toBe(snap.entities.length);

        for (let i = 0; i < snap.entities.length; i += 1) {
          const orig = snap.entities[i];
          const got = decoded.value.entities[i];
          expect(orig).toBeDefined();
          expect(got).toBeDefined();
          if (!orig || !got) continue;

          expect(got.kind).toBe(orig.kind);
          expect(got.id).toBe(orig.id);
          expect(got.pos.x).toBeCloseTo(orig.pos.x, 3);
          expect(got.pos.y).toBeCloseTo(orig.pos.y, 3);
          const angleDiff = Math.abs(normalizeAngle(got.angle - orig.angle));
          expect(angleDiff).toBeLessThanOrEqual(0.002);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('Property 2: Binary packet byte length strictly equals 18 + 24 * entityCount (and 16B for input)', () => {
    fc.assert(
      fc.property(
        snapshotMessageArb,
        fc.integer({ min: 0, max: 100_000 }).map(asSeq),
        fc.integer({ min: 0, max: 100_000 }).map(asTick),
        fc.boolean(),
        fc.float({ min: -1, max: 1, noNaN: true }),
        fc.boolean(),
        (snap, seq, tick, thrust, turn, fire) => {
          const snapBuf = encodeSnapshotBinary(snap);
          expect(snapBuf.byteLength).toBe(18 + 24 * snap.entities.length);

          const inputBuf = binaryCodec.encodeClient({
            type: 'input',
            seq,
            tick,
            thrust,
            turn,
            fire,
            fireHoming: false,
          });
          expect(inputBuf instanceof ArrayBuffer).toBe(true);
          if (inputBuf instanceof ArrayBuffer) {
            expect(inputBuf.byteLength).toBe(16);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 3: Arbitrary malformed byte buffers never crash binary decoders', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 300 }), (bytes) => {
        const clientRes = binaryCodec.decodeClient(bytes);
        expect(typeof clientRes.ok).toBe('boolean');

        const serverRes = binaryCodec.decodeServer(bytes);
        expect(typeof serverRes.ok).toBe('boolean');
      }),
      { numRuns: 250 },
    );
  });

  it('Property 4: Ships always remain inside [0, ARENA.width) x [0, ARENA.height) over 250 random steps', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            thrust: fc.boolean(),
            turn: fc.float({ min: -1, max: 1, noNaN: true }),
            fire: fc.boolean(),
          }),
          { minLength: 50, maxLength: 250 },
        ),
        (steps) => {
          const world = createWorldState({ seed: 2026, asteroidCount: 3 });
          const ship = addShipToWorld(world, { id: asEntityId(1), slotIndex: 0 });

          for (let i = 0; i < steps.length; i += 1) {
            const cmd = steps[i];
            if (!cmd) continue;
            stepWorldState(
              world,
              new Map([[ship.id, { seq: asSeq(i + 1), thrust: cmd.thrust, turn: cmd.turn, fire: cmd.fire }]]),
              FIXED_DT,
              ARENA,
            );
            expect(ship.pos.x).toBeGreaterThanOrEqual(0);
            expect(ship.pos.x).toBeLessThan(ARENA.width);
            expect(ship.pos.y).toBeGreaterThanOrEqual(0);
            expect(ship.pos.y).toBeLessThan(ARENA.height);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('Property 5: parseClientMessage accepts valid generated messages and rejects out-of-range mutations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.boolean(),
        fc.float({ min: -1, max: 1, noNaN: true }),
        fc.boolean(),
        fc.float({ min: Math.fround(1.01), max: 1_000_000, noNaN: true }),
        (seq, tick, thrust, validTurn, fire, badTurn) => {
          const valid = parseClientMessage({
            type: 'input',
            seq,
            tick,
            thrust,
            turn: validTurn,
            fire,
          });
          expect(valid.ok).toBe(true);

          const invalid = parseClientMessage({
            type: 'input',
            seq,
            tick,
            thrust,
            turn: badTurn,
            fire,
          });
          expect(invalid.ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6: Chat and JSON codec round-trip preserves valid messages and rejects malformed JSON', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
        (text) => {
          const codec = getCodec('json');
          const encoded = codec.encodeClient({ type: 'chat', text });
          const decoded = codec.decodeClient(encoded);
          expect(decoded.ok).toBe(true);
          if (decoded.ok && decoded.value.type === 'chat') {
            expect(decoded.value.text).toBe(text.trim());
          }
        },
      ),
      { numRuns: 60 },
    );

    expect(jsonCodec.decodeClient('{broken-json').ok).toBe(false);
    expect(parseServerMessage({ type: 'unknown' }).ok).toBe(false);
  });

  it('Property 7: Determinism holds for arbitrary seeds and random input traces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(
          fc.record({
            thrust: fc.boolean(),
            turn: fc.float({ min: -1, max: 1, noNaN: true }),
            fire: fc.boolean(),
          }),
          { minLength: 10, maxLength: 40 },
        ),
        (seed, trace) => {
          const execute = (): string => {
            const w = createWorldState({ seed, asteroidCount: 4 });
            const s = addShipToWorld(w, { id: asEntityId(1), slotIndex: 0 });
            for (let i = 0; i < trace.length; i += 1) {
              const step = trace[i];
              if (!step) continue;
              stepWorldState(
                w,
                new Map([[s.id, { seq: asSeq(i + 1), thrust: step.thrust, turn: step.turn, fire: step.fire }]]),
              );
            }
            return hashWorldState(w);
          };

          expect(execute()).toBe(execute());
          expect(vec2(1, 2)).toEqual({ x: 1, y: 2 });
        },
      ),
      { numRuns: 40 },
    );
  });
});