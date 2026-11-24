import { MSG_TYPE, PROTOCOL_VERSION, decodeAngleInt16, encodeAngleInt16 } from './protocol.js';

export function encodeInputBinary(input) {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.INPUT);
  const flags = (input.thrust ? 1 : 0) | (input.fire ? 2 : 0) | (input.fireHoming ? 4 : 0);
  view.setUint8(2, flags);
  view.setUint8(3, 0);
  view.setUint32(4, input.seq >>> 0, true);
  view.setUint32(8, (input.tick ?? 0) >>> 0, true);
  view.setFloat32(12, input.turn ?? 0, true);
  return buf;
}

export function encodePingPongBinary(type, clientTimeMs) {
  const buf = new ArrayBuffer(10);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, type);
  view.setFloat64(2, clientTimeMs, true);
  return buf;
}

export function encodeSnapshotBinary(snapshot) {
  const entities = snapshot.entities;
  const buf = new ArrayBuffer(18 + entities.length * 24);
  const view = new DataView(buf);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.SNAPSHOT);
  view.setUint32(2, snapshot.tick >>> 0, true);
  view.setUint32(6, snapshot.lastProcessedSeq >>> 0, true);
  view.setUint16(10, snapshot.yourShipId & 0xffff, true);
  view.setUint16(12, entities.length & 0xffff, true);
  view.setFloat32(14, snapshot.serverTimeMs ?? 0, true);

  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i];
    const o = 18 + i * 24;
    view.setUint16(o, e.id & 0xffff, true);
    view.setUint8(o + 2, e.kind & 0xff);
    const flags = (e.alive ? 1 : 0) | (e.special ? 2 : 0);
    view.setUint8(o + 3, flags);
    view.setFloat32(o + 4, e.x, true);
    view.setFloat32(o + 8, e.y, true);
    view.setFloat32(o + 12, e.vx, true);
    view.setFloat32(o + 16, e.vy, true);
    view.setInt16(o + 20, encodeAngleInt16(e.angle), true);
    view.setUint16(o + 22, (e.extra ?? 0) & 0xffff, true);
  }

  return buf;
}

export function decodeBinaryPacket(bufferOrView, byteOffset = 0, byteLength = undefined) {
  const view = ArrayBuffer.isView(bufferOrView)
    ? new DataView(bufferOrView.buffer, bufferOrView.byteOffset, bufferOrView.byteLength)
    : new DataView(bufferOrView, byteOffset, byteLength);

  if (view.byteLength < 2) {
    throw new Error('Packet too short');
  }

  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const type = view.getUint8(1);

  if (type === MSG_TYPE.INPUT) {
    if (view.byteLength !== 16) throw new Error('Invalid INPUT length');
    const flags = view.getUint8(2);
    return {
      kind: 'input',
      seq: view.getUint32(4, true),
      tick: view.getUint32(8, true),
      thrust: (flags & 1) !== 0,
      fire: (flags & 2) !== 0,
      fireHoming: (flags & 4) !== 0,
      turn: view.getFloat32(12, true),
    };
  }

  if (type === MSG_TYPE.PING || type === MSG_TYPE.PONG) {
    if (view.byteLength !== 10) throw new Error('Invalid PING/PONG length');
    return {
      kind: type === MSG_TYPE.PING ? 'ping' : 'pong',
      clientTimeMs: view.getFloat64(2, true),
    };
  }

  if (type === MSG_TYPE.SNAPSHOT) {
    if (view.byteLength < 18) throw new Error('Invalid SNAPSHOT header');
    const tick = view.getUint32(2, true);
    const lastProcessedSeq = view.getUint32(6, true);
    const yourShipId = view.getUint16(10, true);
    const entityCount = view.getUint16(12, true);
    const serverTimeMs = view.getFloat32(14, true);

    if (view.byteLength !== 18 + entityCount * 24) {
      throw new Error(`SNAPSHOT size mismatch: expected ${18 + entityCount * 24}, got ${view.byteLength}`);
    }

    const entities = new Array(entityCount);
    for (let i = 0; i < entityCount; i += 1) {
      const o = 18 + i * 24;
      const flags = view.getUint8(o + 3);
      entities[i] = {
        id: view.getUint16(o, true),
        kind: view.getUint8(o + 2),
        alive: (flags & 1) !== 0,
        special: (flags & 2) !== 0,
        x: view.getFloat32(o + 4, true),
        y: view.getFloat32(o + 8, true),
        vx: view.getFloat32(o + 12, true),
        vy: view.getFloat32(o + 16, true),
        angle: decodeAngleInt16(view.getInt16(o + 20, true)),
        extra: view.getUint16(o + 22, true),
      };
    }

    return {
      kind: 'snapshot',
      tick,
      lastProcessedSeq,
      yourShipId,
      serverTimeMs,
      entities,
    };
  }

  throw new Error(`Unknown binary packet type: ${type}`);
}
