export const PROTOCOL_VERSION = 1;

export const MSG_TYPE = Object.freeze({
  INPUT: 0x01,
  SNAPSHOT: 0x02,
  PING: 0x03,
  PONG: 0x04,
});

export const ENTITY_KIND = Object.freeze({
  SHIP: 1,
  ASTEROID: 2,
  BULLET: 3,
});

export function normalizeAngle(rad) {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function encodeAngleInt16(rad) {
  const wrapped = normalizeAngle(rad);
  return Math.max(-32768, Math.min(32767, Math.round(wrapped * 1000)));
}

export function decodeAngleInt16(int16Val) {
  return int16Val / 1000;
}

export function validateInputPacket(input) {
  if (!input || typeof input !== 'object') return null;
  const seq = Number(input.seq);
  const tick = Number(input.tick ?? 0);
  const turn = Number(input.turn ?? 0);

  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) return null;
  if (!Number.isInteger(tick) || tick < 0 || tick > 0xffffffff) return null;
  if (!Number.isFinite(turn) || Math.abs(turn) > 1.05) return null;

  return {
    seq,
    tick,
    thrust: Boolean(input.thrust),
    turn: Math.max(-1, Math.min(1, turn)),
    fire: Boolean(input.fire),
    fireHoming: Boolean(input.fireHoming),
  };
}
