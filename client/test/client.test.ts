import { describe, expect, it } from 'vitest';
import {
  type EntityId,
  type RoomId,
  type SnapshotMessage,
  asEntityId,
  asRadians,
  asSeq,
  asTick,
  vec2,
} from '../../shared/src/index.ts';
import { Bus } from '../src/bus.ts';
import { EntityInterpolator, INTERPOLATION_DELAY_MS } from '../src/interpolator.ts';
import { FrameTimeTracker } from '../src/metrics.ts';
import { LocalShipPredictor } from '../src/predictor.ts';

function makeShipSnapshot(
  tick: number,
  lastProcessedSeq: number,
  shipId: EntityId,
  x: number,
  y: number,
  vx = 0,
  vy = 0,
): SnapshotMessage {
  return {
    type: 'snapshot',
    tick: asTick(tick),
    lastProcessedSeq: asSeq(lastProcessedSeq),
    yourShipId: shipId,
    serverTimeMs: tick * 33.3,
    entities: [
      {
        kind: 'ship',
        id: shipId,
        pos: vec2(x, y),
        vel: vec2(vx, vy),
        angle: asRadians(0),
        alive: true,
        thrusting: false,
        hp: 100,
        score: 0,
        name: 'Viper',
      },
    ],
  };
}

describe('LocalShipPredictor reconciliation & prediction', () => {
  const myId = asEntityId(1);

  it('initializes local ship state from first snapshot', () => {
    const predictor = new LocalShipPredictor();
    expect(predictor.getRenderShip(myId)).toBeNull();

    predictor.reconcile(makeShipSnapshot(1, 0, myId, 250, 300));
    const rendered = predictor.getRenderShip(myId);
    expect(rendered).not.toBeNull();
    expect(rendered?.pos).toEqual({ x: 250, y: 300 });
  });

  it('predicts forward movement immediately on recordInput when prediction is enabled', () => {
    const predictor = new LocalShipPredictor();
    predictor.reconcile(makeShipSnapshot(1, 0, myId, 200, 300));

    predictor.recordInput({
      type: 'input',
      seq: asSeq(1),
      tick: asTick(1),
      thrust: true,
      turn: 0,
      fire: false,
      fireHoming: false,
    });

    expect(predictor.queueLength).toBe(1);
    const rendered = predictor.getRenderShip(myId);
    expect(rendered?.pos.x).toBeGreaterThan(200);
  });

  it('does not predict locally when predictionEnabled is false', () => {
    const predictor = new LocalShipPredictor();
    predictor.predictionEnabled = false;
    predictor.reconcile(makeShipSnapshot(1, 0, myId, 200, 300));

    predictor.recordInput({
      type: 'input',
      seq: asSeq(1),
      tick: asTick(1),
      thrust: true,
      turn: 0,
      fire: false,
      fireHoming: false,
    });

    expect(predictor.getRenderShip(myId)?.pos.x).toBe(200);
  });

  it('discards acknowledged inputs and replays remaining unacknowledged inputs', () => {
    const predictor = new LocalShipPredictor();
    predictor.reconcile(makeShipSnapshot(1, 0, myId, 200, 300));

    for (let s = 1; s <= 4; s += 1) {
      predictor.recordInput({
        type: 'input',
        seq: asSeq(s),
        tick: asTick(s),
        thrust: true,
        turn: 0,
        fire: false,
        fireHoming: false,
      });
    }
    expect(predictor.queueLength).toBe(4);

    predictor.reconcile(makeShipSnapshot(3, 2, myId, 201, 300, 20, 0));
    expect(predictor.queueLength).toBe(2);
    expect(predictor.getRenderShip(myId)?.pos.x).toBeGreaterThan(201);
  });

  it('applies exponential visual smoothing on small reconciliation errors and snaps on teleports', () => {
    const predictor = new LocalShipPredictor();
    predictor.reconcile(makeShipSnapshot(1, 0, myId, 200, 300));

    predictor.reconcile(makeShipSnapshot(2, 0, myId, 210, 300));
    expect(predictor.lastReconcileErrorPx).toBeCloseTo(10, 2);
    const beforeDecay = predictor.getRenderShip(myId)?.pos.x ?? 0;
    expect(beforeDecay).toBeCloseTo(200, 1);

    predictor.decaySmoothing(0.2);
    const afterDecay = predictor.getRenderShip(myId)?.pos.x ?? 0;
    expect(afterDecay).toBeGreaterThan(205);

    predictor.reconcile(makeShipSnapshot(3, 0, myId, 610, 300));
    expect(predictor.getRenderShip(myId)?.pos.x).toBeCloseTo(610, 1);
  });

  it('resets predictor state cleanly', () => {
    const predictor = new LocalShipPredictor();
    predictor.reconcile(makeShipSnapshot(1, 0, myId, 200, 300));
    predictor.reset();
    expect(predictor.getRenderShip(myId)).toBeNull();
    expect(predictor.queueLength).toBe(0);
  });
});

describe('EntityInterpolator', () => {
  const localId = asEntityId(1);
  const remoteId = asEntityId(2);

  it('returns empty array when no snapshots are buffered', () => {
    const interp = new EntityInterpolator();
    expect(interp.sample(1000, localId)).toEqual([]);
  });

  it('excludes local ship and interpolates remote entity halfway between snapshots', () => {
    const interp = new EntityInterpolator();
    const localShip = {
      kind: 'ship' as const,
      id: localId,
      pos: vec2(50, 50),
      vel: vec2(0, 0),
      angle: asRadians(0),
      alive: true,
      thrusting: false,
      hp: 100,
      score: 0,
      name: 'Local',
    };
    const remoteShipStart = {
      kind: 'ship' as const,
      id: remoteId,
      pos: vec2(100, 200),
      vel: vec2(100, 0),
      angle: asRadians(0),
      alive: true,
      thrusting: true,
      hp: 100,
      score: 0,
      name: 'Remote',
    };
    const s1: SnapshotMessage = {
      type: 'snapshot',
      tick: asTick(1),
      lastProcessedSeq: asSeq(0),
      yourShipId: localId,
      serverTimeMs: 1000,
      entities: [localShip, remoteShipStart],
    };
    const s2: SnapshotMessage = {
      ...s1,
      tick: asTick(2),
      serverTimeMs: 1100,
      entities: [
        localShip,
        {
          ...remoteShipStart,
          pos: vec2(200, 200),
        },
      ],
    };

    interp.push(s1, 1000);
    interp.push(s2, 1100);

    const sampled = interp.sample(1050 + INTERPOLATION_DELAY_MS, localId);
    expect(sampled).toHaveLength(1);
    expect(sampled[0]?.id).toBe(remoteId);
    expect(sampled[0]?.pos.x).toBeCloseTo(150, 2);
  });

  it('interpolates shortest toroidal path across arena edge', () => {
    const interp = new EntityInterpolator();
    const asteroidStart = {
      kind: 'asteroid' as const,
      id: asEntityId(50),
      pos: vec2(890, 300),
      vel: vec2(20, 0),
      angle: asRadians(0),
      radius: 25,
      homing: false,
    };
    const s1: SnapshotMessage = {
      type: 'snapshot',
      tick: asTick(1),
      lastProcessedSeq: asSeq(0),
      yourShipId: localId,
      serverTimeMs: 1000,
      entities: [asteroidStart],
    };
    const s2: SnapshotMessage = {
      ...s1,
      tick: asTick(2),
      entities: [
        {
          ...asteroidStart,
          pos: vec2(10, 300),
        },
      ],
    };

    interp.push(s1, 1000);
    interp.push(s2, 1100);

    const sampled = interp.sample(1050 + INTERPOLATION_DELAY_MS, localId);
    expect(sampled[0]?.pos.x).toBeCloseTo(0, 2);
  });
});

describe('FrameTimeTracker & Typed Bus', () => {
  it('computes p50, p95, p99 and FPS from recorded frame durations', () => {
    const tracker = new FrameTimeTracker(100);
    expect(tracker.getSummary().sampleCount).toBe(0);

    for (let i = 1; i <= 100; i += 1) {
      tracker.record(i * 0.1);
    }

    const summary = tracker.getSummary();
    expect(summary.sampleCount).toBe(100);
    expect(summary.p50Ms).toBeCloseTo(5.1, 1);
    expect(summary.p95Ms).toBeCloseTo(9.6, 1);
    expect(summary.p99Ms).toBeCloseTo(10.0, 1);
    expect(summary.fps).toBeGreaterThan(100);
  });

  it('delivers typed events on Bus and supports unsubscription', () => {
    const bus = new Bus<{ joined: { room: RoomId } }>();
    const seen: string[] = [];
    const off = bus.on('joined', ({ room }) => seen.push(room));

    bus.emit('joined', { room: 'Alpha' as RoomId });
    off();
    bus.emit('joined', { room: 'Beta' as RoomId });

    expect(seen).toEqual(['Alpha']);
  });
});
