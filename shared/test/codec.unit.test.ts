import { describe, expect, it } from 'vitest';
import {
  BINARY_MSG_TYPE,
  PROTOCOL_VERSION,
  asEntityId,
  asRadians,
  asRoomId,
  asSeq,
  asTick,
  binaryCodec,
  decodeSnapshotBinary,
  encodeSnapshotBinary,
  getCodec,
  jsonCodec,
  vec2,
} from '../src/index.ts';

describe('Binary & JSON codec unit tests', () => {
  it('encodes and decodes binary ping and pong packets accurately', () => {
    const pingBuf = binaryCodec.encodeClient({ type: 'ping', clientTimeMs: 12345.5 });
    expect(pingBuf instanceof ArrayBuffer).toBe(true);
    const pingRes = binaryCodec.decodeClient(pingBuf);
    expect(pingRes.ok).toBe(true);
    if (pingRes.ok && pingRes.value.type === 'ping') {
      expect(pingRes.value.clientTimeMs).toBeCloseTo(12345.5, 5);
    }

    const pongBuf = binaryCodec.encodeServer({
      type: 'pong',
      clientTimeMs: 12345.5,
      serverTimeMs: 12360.0,
    });
    const pongRes = binaryCodec.decodeServer(pongBuf);
    expect(pongRes.ok).toBe(true);
    if (pongRes.ok && pongRes.value.type === 'pong') {
      expect(pongRes.value.clientTimeMs).toBeCloseTo(12345.5, 5);
    }
  });

  it('falls back to JSON strings for join, netConfig, welcome, and error in BinaryCodec', () => {
    const joinEncoded = binaryCodec.encodeClient({
      type: 'join',
      room: asRoomId('Alpha'),
      name: 'Viper',
    });
    expect(typeof joinEncoded).toBe('string');
    const joinDecoded = binaryCodec.decodeClient(joinEncoded);
    expect(joinDecoded.ok).toBe(true);

    const errEncoded = binaryCodec.encodeServer({
      type: 'error',
      code: 'TEST',
      message: 'Sample error',
    });
    expect(typeof errEncoded).toBe('string');
    const errDecoded = binaryCodec.decodeServer(errEncoded);
    expect(errDecoded.ok).toBe(true);
  });

  it('rejects binary packets with wrong protocol version or truncated headers', () => {
    const badVer = new Uint8Array([99, BINARY_MSG_TYPE.PING, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(binaryCodec.decodeClient(badVer).ok).toBe(false);
    expect(binaryCodec.decodeServer(badVer).ok).toBe(false);

    expect(binaryCodec.decodeClient(new Uint8Array([1])).ok).toBe(false);
    expect(binaryCodec.decodeServer(new Uint8Array([1])).ok).toBe(false);
  });

  it('rejects binary INPUT packet with wrong byte length or out-of-range turn', () => {
    const wrongLen = new Uint8Array([PROTOCOL_VERSION, BINARY_MSG_TYPE.INPUT, 0, 0]);
    expect(binaryCodec.decodeClient(wrongLen).ok).toBe(false);

    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, BINARY_MSG_TYPE.INPUT);
    view.setFloat32(12, 9.5, true);
    expect(binaryCodec.decodeClient(buf).ok).toBe(false);
  });

  it('rejects binary SNAPSHOT with mismatched entity length or unknown entity kind', () => {
    const snapBuf = encodeSnapshotBinary({
      type: 'snapshot',
      tick: asTick(1),
      lastProcessedSeq: asSeq(1),
      yourShipId: asEntityId(1),
      serverTimeMs: 100,
      entities: [
        {
          kind: 'ship',
          id: asEntityId(1),
          pos: vec2(10, 20),
          vel: vec2(0, 0),
          angle: asRadians(0),
          alive: true,
          thrusting: false,
          hp: 100,
          score: 0,
          name: 'A',
        },
      ],
    });

    // Corrupt entity kind byte (offset 18 + 2 = 20)
    const corrupted = new Uint8Array(snapBuf.slice(0));
    corrupted[20] = 250;
    expect(decodeSnapshotBinary(corrupted).ok).toBe(false);

    // Truncate 4 bytes
    expect(decodeSnapshotBinary(snapBuf.slice(0, snapBuf.byteLength - 4)).ok).toBe(false);
  });

  it('accepts Uint8Array views and rejects non-buffer inputs cleanly', () => {
    const pingBuf = binaryCodec.encodeClient({ type: 'ping', clientTimeMs: 42 }) as ArrayBuffer;
    const asView = new Uint8Array(pingBuf);
    expect(binaryCodec.decodeClient(asView).ok).toBe(true);
    expect(binaryCodec.decodeClient(12345).ok).toBe(false);
    expect(binaryCodec.decodeServer(null).ok).toBe(false);
  });

  it('JsonCodec decodes both JSON strings and pre-parsed objects', () => {
    const rawObj = { type: 'ping', clientTimeMs: 500 };
    expect(jsonCodec.decodeClient(rawObj).ok).toBe(true);
    expect(jsonCodec.decodeServer({ type: 'pong', clientTimeMs: 500, serverTimeMs: 510 }).ok).toBe(true);
    expect(getCodec('binary').name).toBe('binary');
    expect(getCodec('json').name).toBe('json');
  });
});
