export type Brand<T, B extends string> = T & { readonly __brand: B };

export type EntityId = Brand<number, 'EntityId'>;
export type Tick = Brand<number, 'Tick'>;
export type Seq = Brand<number, 'Seq'>;
export type RoomId = Brand<string, 'RoomId'>;
export type Radians = Brand<number, 'Radians'>;

function makeBrand<T, B extends string>(value: T): Brand<T, B> {
  // Single nominal cast helper for branded primitive wrappers
  return value as Brand<T, B>;
}

export const asEntityId = (n: number): EntityId => makeBrand<number, 'EntityId'>(n);
export const asTick = (n: number): Tick => makeBrand<number, 'Tick'>(n);
export const asSeq = (n: number): Seq => makeBrand<number, 'Seq'>(n);
export const asRoomId = (s: string): RoomId => makeBrand<string, 'RoomId'>(s);
export const asRadians = (n: number): Radians => makeBrand<number, 'Radians'>(n);

export interface Vector2 {
  readonly x: number;
  readonly y: number;
}

export interface MutVec2 {
  x: number;
  y: number;
}

export const ZERO_VEC2: Vector2 = Object.freeze({ x: 0, y: 0 });

export function vec2(x: number, y: number): Vector2 {
  return { x, y };
}

export function mutVec2(x = 0, y = 0): MutVec2 {
  return { x, y };
}

export function setVec2(out: MutVec2, x: number, y: number): MutVec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function addVec2(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function addVec2InPlace(out: MutVec2, b: Vector2): MutVec2 {
  out.x += b.x;
  out.y += b.y;
  return out;
}

export function subVec2(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVec2(v: Vector2, k: number): Vector2 {
  return { x: v.x * k, y: v.y * k };
}

export function scaleVec2InPlace(out: MutVec2, k: number): MutVec2 {
  out.x *= k;
  out.y *= k;
  return out;
}

export function lenVec2(v: Vector2): number {
  return Math.hypot(v.x, v.y);
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };