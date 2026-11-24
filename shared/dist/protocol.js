import { z } from 'zod';
import { asEntityId, asRadians, asRoomId, asSeq, asTick } from "./types.js";
export const PROTOCOL_VERSION = 1;
export const BINARY_MSG_TYPE = {
    INPUT: 0x01,
    SNAPSHOT: 0x02,
    PING: 0x03,
    PONG: 0x04,
};
export const BINARY_ENTITY_KIND = {
    SHIP: 1,
    ASTEROID: 2,
    BULLET: 3,
};
export const CodecKindSchema = z.enum(['binary', 'json']);
const Vector2Schema = z
    .object({
    x: z.number().finite(),
    y: z.number().finite(),
})
    .readonly();
const EntityIdSchema = z.number().int().nonnegative().max(0xffff).transform(asEntityId);
const TickSchema = z.number().int().nonnegative().max(0xffffffff).transform(asTick);
const SeqSchema = z.number().int().nonnegative().max(0xffffffff).transform(asSeq);
const RadiansSchema = z.number().finite().transform(asRadians);
const RoomIdSchema = z.string().trim().min(1).max(32).transform(asRoomId);
export const JoinMessageSchema = z.object({
    type: z.literal('join'),
    room: RoomIdSchema,
    name: z.string().trim().min(1).max(24),
});
export const InputMessageSchema = z.object({
    type: z.literal('input'),
    seq: SeqSchema,
    tick: TickSchema,
    thrust: z.boolean(),
    turn: z.number().finite().min(-1).max(1),
    fire: z.boolean(),
    fireHoming: z.boolean().optional().default(false),
});
export const PingMessageSchema = z.object({
    type: z.literal('ping'),
    clientTimeMs: z.number().finite().nonnegative(),
});
export const NetConfigMessageSchema = z.object({
    type: z.literal('netConfig'),
    latencyMs: z.number().finite().min(0).max(1000),
    jitterMs: z.number().finite().min(0).max(500),
    dropRate: z.number().finite().min(0).max(0.9),
    codec: CodecKindSchema.optional(),
});
export const ChatClientMessageSchema = z.object({
    type: z.literal('chat'),
    text: z.string().trim().min(1).max(160),
});
export const ClientMessageSchema = z.discriminatedUnion('type', [
    JoinMessageSchema,
    InputMessageSchema,
    PingMessageSchema,
    NetConfigMessageSchema,
    ChatClientMessageSchema,
]);
export const ShipSnapshotEntitySchema = z.object({
    kind: z.literal('ship'),
    id: EntityIdSchema,
    pos: Vector2Schema,
    vel: Vector2Schema,
    angle: RadiansSchema,
    alive: z.boolean(),
    thrusting: z.boolean(),
    hp: z.number().int().min(0).max(1000),
    score: z.number().int().min(0),
    name: z.string(),
});
export const AsteroidSnapshotEntitySchema = z.object({
    kind: z.literal('asteroid'),
    id: EntityIdSchema,
    pos: Vector2Schema,
    vel: Vector2Schema,
    angle: RadiansSchema,
    radius: z.number().positive(),
    homing: z.boolean(),
});
export const BulletSnapshotEntitySchema = z.object({
    kind: z.literal('bullet'),
    id: EntityIdSchema,
    pos: Vector2Schema,
    vel: Vector2Schema,
    angle: RadiansSchema,
    ownerId: EntityIdSchema,
    homing: z.boolean(),
});
export const SnapshotEntitySchema = z.discriminatedUnion('kind', [
    ShipSnapshotEntitySchema,
    AsteroidSnapshotEntitySchema,
    BulletSnapshotEntitySchema,
]);
export const SnapshotMessageSchema = z.object({
    type: z.literal('snapshot'),
    tick: TickSchema,
    lastProcessedSeq: SeqSchema,
    yourShipId: EntityIdSchema,
    serverTimeMs: z.number().finite(),
    entities: z.array(SnapshotEntitySchema),
});
export const WelcomeMessageSchema = z.object({
    type: z.literal('welcome'),
    shipId: EntityIdSchema,
    roomId: RoomIdSchema,
    tickRate: z.number().int().positive(),
    snapshot: SnapshotMessageSchema,
});
export const PongMessageSchema = z.object({
    type: z.literal('pong'),
    clientTimeMs: z.number().finite(),
    serverTimeMs: z.number().finite(),
});
export const ErrorMessageSchema = z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
});
export const ChatServerMessageSchema = z.object({
    type: z.literal('chat'),
    fromShipId: EntityIdSchema,
    fromName: z.string(),
    text: z.string(),
});
export const ShutdownServerMessageSchema = z.object({
    type: z.literal('shutdown'),
    reason: z.string(),
    reconnectMs: z.number().int().nonnegative(),
});
export const ServerMessageSchema = z.discriminatedUnion('type', [
    WelcomeMessageSchema,
    SnapshotMessageSchema,
    PongMessageSchema,
    ErrorMessageSchema,
    ChatServerMessageSchema,
    ShutdownServerMessageSchema,
]);
export function parseClientMessage(raw) {
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        return { ok: false, error: details || 'Invalid client message' };
    }
    return { ok: true, value: parsed.data };
}
export function parseServerMessage(raw) {
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        return { ok: false, error: details || 'Invalid server message' };
    }
    return { ok: true, value: parsed.data };
}
export function normalizeAngle(rad) {
    let a = rad;
    while (a > Math.PI)
        a -= Math.PI * 2;
    while (a < -Math.PI)
        a += Math.PI * 2;
    return asRadians(a);
}
export function encodeAngleInt16(rad) {
    const wrapped = normalizeAngle(rad);
    return Math.max(-32768, Math.min(32767, Math.round(wrapped * 1000)));
}
export function decodeAngleInt16(int16Val) {
    return asRadians(int16Val / 1000);
}
