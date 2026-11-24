import {
  BINARY_ENTITY_KIND,
  BINARY_MSG_TYPE,
  type ClientMessage,
  type CodecKind,
  type InputMessage,
  PROTOCOL_VERSION,
  type PingMessage,
  type PongMessage,
  type ServerMessage,
  type SnapshotEntity,
  type SnapshotMessage,
  decodeAngleInt16,
  encodeAngleInt16,
  parseClientMessage,
  parseServerMessage,
} from './protocol.ts';
import { type ParseResult, asEntityId, asSeq, asTick, vec2 } from './types.ts';

const MAX_ENTITIES_PER_SNAPSHOT = 1024;
const SNAPSHOT_HEADER_BYTES = 18;
const ENTITY_RECORD_BYTES = 24;
const INPUT_PACKET_BYTES = 16;
const PING_PACKET_BYTES = 10;

export interface Codec {
  readonly name: CodecKind;
  encodeClient(msg: ClientMessage): ArrayBuffer | string;
  decodeClient(raw: unknown): ParseResult<ClientMessage>;
  encodeServer(msg: ServerMessage): ArrayBuffer | string;
  decodeServer(raw: unknown): ParseResult<ServerMessage>;
}

function encodeInputBinary(input: InputMessage): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_PACKET_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, BINARY_MSG_TYPE.INPUT);
  const flags = (input.thrust ? 1 : 0) | (input.fire ? 2 : 0) | (input.fireHoming ? 4 : 0);
  view.setUint8(2, flags);
  view.setUint8(3, 0);
  view.setUint32(4, input.seq >>> 0, true);
  view.setUint32(8, input.tick >>> 0, true);
  view.setFloat32(12, input.turn, true);
  return buf;
}

function encodePingPongBinary(
  type: typeof BINARY_MSG_TYPE.PING | typeof BINARY_MSG_TYPE.PONG,
  clientTimeMs: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(PING_PACKET_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, type);
  view.setFloat64(2, clientTimeMs, true);
  return buf;
}

export function encodeSnapshotBinary(snapshot: SnapshotMessage): ArrayBuffer {
  const entities = snapshot.entities;
  if (entities.length > MAX_ENTITIES_PER_SNAPSHOT) {
    throw new Error(`Too many entities in snapshot: ${entities.length}`);
  }

  const buf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + entities.length * ENTITY_RECORD_BYTES);
  const view = new DataView(buf);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, BINARY_MSG_TYPE.SNAPSHOT);
  view.setUint32(2, snapshot.tick >>> 0, true);
  view.setUint32(6, snapshot.lastProcessedSeq >>> 0, true);
  view.setUint16(10, snapshot.yourShipId & 0xffff, true);
  view.setUint16(12, entities.length & 0xffff, true);
  view.setFloat32(14, snapshot.serverTimeMs, true);

  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i];
    if (!e) continue;
    const o = SNAPSHOT_HEADER_BYTES + i * ENTITY_RECORD_BYTES;
    view.setUint16(o, e.id & 0xffff, true);
    view.setFloat32(o + 4, e.pos.x, true);
    view.setFloat32(o + 8, e.pos.y, true);
    view.setFloat32(o + 12, e.vel.x, true);
    view.setFloat32(o + 16, e.vel.y, true);
    view.setInt16(o + 20, encodeAngleInt16(e.angle), true);

    switch (e.kind) {
      case 'ship': {
        view.setUint8(o + 2, BINARY_ENTITY_KIND.SHIP);
        const flags = (e.alive ? 1 : 0) | (e.thrusting ? 2 : 0);
        view.setUint8(o + 3, flags);
        view.setUint16(o + 22, e.hp & 0xffff, true);
        break;
      }
      case 'asteroid': {
        view.setUint8(o + 2, BINARY_ENTITY_KIND.ASTEROID);
        const flags = 1 | (e.homing ? 2 : 0);
        view.setUint8(o + 3, flags);
        view.setUint16(o + 22, Math.round(e.radius) & 0xffff, true);
        break;
      }
      case 'bullet': {
        view.setUint8(o + 2, BINARY_ENTITY_KIND.BULLET);
        const flags = 1 | (e.homing ? 2 : 0);
        view.setUint8(o + 3, flags);
        view.setUint16(o + 22, e.ownerId & 0xffff, true);
        break;
      }
      default: {
        const _exhaustive: never = e;
        throw new Error(`Unsupported entity kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return buf;
}

function toDataView(raw: unknown): DataView | null {
  if (raw instanceof ArrayBuffer) {
    return new DataView(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export function decodeSnapshotBinary(raw: unknown): ParseResult<SnapshotMessage> {
  const view = toDataView(raw);
  if (!view) {
    return { ok: false, error: 'Expected ArrayBuffer or TypedArray for binary snapshot' };
  }
  if (view.byteLength < SNAPSHOT_HEADER_BYTES) {
    return { ok: false, error: `Snapshot header too short: ${view.byteLength} bytes` };
  }
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${version}` };
  }
  const msgType = view.getUint8(1);
  if (msgType !== BINARY_MSG_TYPE.SNAPSHOT) {
    return { ok: false, error: `Expected SNAPSHOT packet (0x02), got 0x${msgType.toString(16)}` };
  }

  const tick = asTick(view.getUint32(2, true));
  const lastProcessedSeq = asSeq(view.getUint32(6, true));
  const yourShipId = asEntityId(view.getUint16(10, true));
  const entityCount = view.getUint16(12, true);
  const serverTimeMs = view.getFloat32(14, true);

  if (entityCount > MAX_ENTITIES_PER_SNAPSHOT) {
    return { ok: false, error: `Snapshot entity count exceeds limit: ${entityCount}` };
  }
  if (!Number.isFinite(serverTimeMs)) {
    return { ok: false, error: 'Invalid serverTimeMs in snapshot' };
  }
  const expectedLength = SNAPSHOT_HEADER_BYTES + entityCount * ENTITY_RECORD_BYTES;
  if (view.byteLength !== expectedLength) {
    return {
      ok: false,
      error: `Snapshot byte length mismatch: expected ${expectedLength}, got ${view.byteLength}`,
    };
  }

  const entities: SnapshotEntity[] = [];
  for (let i = 0; i < entityCount; i += 1) {
    const o = SNAPSHOT_HEADER_BYTES + i * ENTITY_RECORD_BYTES;
    const id = asEntityId(view.getUint16(o, true));
    const kindCode = view.getUint8(o + 2);
    const flags = view.getUint8(o + 3);
    const x = view.getFloat32(o + 4, true);
    const y = view.getFloat32(o + 8, true);
    const vx = view.getFloat32(o + 12, true);
    const vy = view.getFloat32(o + 16, true);
    const angle = decodeAngleInt16(view.getInt16(o + 20, true));
    const extra = view.getUint16(o + 22, true);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx) || !Number.isFinite(vy)) {
      return { ok: false, error: `Non-finite coordinates in entity ${id}` };
    }

    const pos = vec2(x, y);
    const vel = vec2(vx, vy);

    switch (kindCode) {
      case BINARY_ENTITY_KIND.SHIP:
        entities.push({
          kind: 'ship',
          id,
          pos,
          vel,
          angle,
          alive: (flags & 1) !== 0,
          thrusting: (flags & 2) !== 0,
          hp: extra,
          score: 0,
          name: `Pilot-${id}`,
        });
        break;
      case BINARY_ENTITY_KIND.ASTEROID:
        entities.push({
          kind: 'asteroid',
          id,
          pos,
          vel,
          angle,
          radius: Math.max(1, extra),
          homing: (flags & 2) !== 0,
        });
        break;
      case BINARY_ENTITY_KIND.BULLET:
        entities.push({
          kind: 'bullet',
          id,
          pos,
          vel,
          angle,
          ownerId: asEntityId(extra),
          homing: (flags & 2) !== 0,
        });
        break;
      default:
        return { ok: false, error: `Unknown entity kind code: ${kindCode}` };
    }
  }

  return {
    ok: true,
    value: {
      type: 'snapshot',
      tick,
      lastProcessedSeq,
      yourShipId,
      serverTimeMs,
      entities,
    },
  };
}

function parseJsonString(text: string): ParseResult<unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Malformed JSON: ${message}` };
  }
}

export class JsonCodec implements Codec {
  public readonly name = 'json' as const;

  public encodeClient(msg: ClientMessage): string {
    return JSON.stringify(msg);
  }

  public decodeClient(raw: unknown): ParseResult<ClientMessage> {
    if (typeof raw === 'string') {
      const json = parseJsonString(raw);
      if (!json.ok) return json;
      return parseClientMessage(json.value);
    }
    return parseClientMessage(raw);
  }

  public encodeServer(msg: ServerMessage): string {
    return JSON.stringify(msg);
  }

  public decodeServer(raw: unknown): ParseResult<ServerMessage> {
    if (typeof raw === 'string') {
      const json = parseJsonString(raw);
      if (!json.ok) return json;
      return parseServerMessage(json.value);
    }
    return parseServerMessage(raw);
  }
}

export class BinaryCodec implements Codec {
  public readonly name = 'binary' as const;
  private readonly jsonFallback = new JsonCodec();

  public encodeClient(msg: ClientMessage): ArrayBuffer | string {
    switch (msg.type) {
      case 'input':
        return encodeInputBinary(msg);
      case 'ping':
        return encodePingPongBinary(BINARY_MSG_TYPE.PING, msg.clientTimeMs);
      case 'join':
      case 'netConfig':
      case 'chat':
        return this.jsonFallback.encodeClient(msg);
      default: {
        const _exhaustive: never = msg;
        throw new Error(`Unhandled client message: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  public decodeClient(raw: unknown): ParseResult<ClientMessage> {
    if (typeof raw === 'string') {
      return this.jsonFallback.decodeClient(raw);
    }
    const view = toDataView(raw);
    if (!view) {
      return { ok: false, error: 'Unsupported client payload type' };
    }
    if (view.byteLength < 2) {
      return { ok: false, error: 'Binary client packet too short' };
    }
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
      return { ok: false, error: `Unsupported protocol version: ${version}` };
    }
    const msgType = view.getUint8(1);
    switch (msgType) {
      case BINARY_MSG_TYPE.INPUT: {
        if (view.byteLength !== INPUT_PACKET_BYTES) {
          return { ok: false, error: `Invalid INPUT length: ${view.byteLength}` };
        }
        const flags = view.getUint8(2);
        const seq = view.getUint32(4, true);
        const tick = view.getUint32(8, true);
        const turn = view.getFloat32(12, true);
        if (!Number.isFinite(turn) || Math.abs(turn) > 1.05) {
          return { ok: false, error: `Out-of-range turn value: ${turn}` };
        }
        const msg: InputMessage = {
          type: 'input',
          seq: asSeq(seq),
          tick: asTick(tick),
          thrust: (flags & 1) !== 0,
          fire: (flags & 2) !== 0,
          fireHoming: (flags & 4) !== 0,
          turn: Math.max(-1, Math.min(1, turn)),
        };
        return { ok: true, value: msg };
      }
      case BINARY_MSG_TYPE.PING: {
        if (view.byteLength !== PING_PACKET_BYTES) {
          return { ok: false, error: `Invalid PING length: ${view.byteLength}` };
        }
        const clientTimeMs = view.getFloat64(2, true);
        if (!Number.isFinite(clientTimeMs) || clientTimeMs < 0) {
          return { ok: false, error: 'Invalid PING timestamp' };
        }
        const msg: PingMessage = {
          type: 'ping',
          clientTimeMs,
        };
        return { ok: true, value: msg };
      }
      default:
        return { ok: false, error: `Unknown binary client message type: 0x${msgType.toString(16)}` };
    }
  }

  public encodeServer(msg: ServerMessage): ArrayBuffer | string {
    switch (msg.type) {
      case 'snapshot':
        return encodeSnapshotBinary(msg);
      case 'pong':
        return encodePingPongBinary(BINARY_MSG_TYPE.PONG, msg.clientTimeMs);
      case 'welcome':
      case 'error':
      case 'chat':
      case 'shutdown':
        return this.jsonFallback.encodeServer(msg);
      default: {
        const _exhaustive: never = msg;
        throw new Error(`Unhandled server message: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  public decodeServer(raw: unknown): ParseResult<ServerMessage> {
    if (typeof raw === 'string') {
      return this.jsonFallback.decodeServer(raw);
    }
    const view = toDataView(raw);
    if (!view) {
      return { ok: false, error: 'Unsupported server payload type' };
    }
    if (view.byteLength < 2) {
      return { ok: false, error: 'Binary server packet too short' };
    }
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
      return { ok: false, error: `Unsupported protocol version: ${version}` };
    }
    const msgType = view.getUint8(1);
    switch (msgType) {
      case BINARY_MSG_TYPE.SNAPSHOT:
        return decodeSnapshotBinary(view);
      case BINARY_MSG_TYPE.PONG: {
        if (view.byteLength !== PING_PACKET_BYTES) {
          return { ok: false, error: `Invalid PONG length: ${view.byteLength}` };
        }
        const clientTimeMs = view.getFloat64(2, true);
        if (!Number.isFinite(clientTimeMs)) {
          return { ok: false, error: 'Invalid PONG timestamp' };
        }
        const msg: PongMessage = {
          type: 'pong',
          clientTimeMs,
          serverTimeMs: 0,
        };
        return { ok: true, value: msg };
      }
      default:
        return { ok: false, error: `Unknown binary server message type: 0x${msgType.toString(16)}` };
    }
  }
}

export const jsonCodec = new JsonCodec();
export const binaryCodec = new BinaryCodec();

export function getCodec(kind: CodecKind): Codec {
  switch (kind) {
    case 'binary':
      return binaryCodec;
    case 'json':
      return jsonCodec;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown codec kind: ${String(_exhaustive)}`);
    }
  }
}
