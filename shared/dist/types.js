function makeBrand(value) {
    // Single nominal cast helper for branded primitive wrappers
    return value;
}
export const asEntityId = (n) => makeBrand(n);
export const asTick = (n) => makeBrand(n);
export const asSeq = (n) => makeBrand(n);
export const asRoomId = (s) => makeBrand(s);
export const asRadians = (n) => makeBrand(n);
export const ZERO_VEC2 = Object.freeze({ x: 0, y: 0 });
export function vec2(x, y) {
    return { x, y };
}
export function mutVec2(x = 0, y = 0) {
    return { x, y };
}
export function setVec2(out, x, y) {
    out.x = x;
    out.y = y;
    return out;
}
export function addVec2(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
}
export function addVec2InPlace(out, b) {
    out.x += b.x;
    out.y += b.y;
    return out;
}
export function subVec2(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}
export function scaleVec2(v, k) {
    return { x: v.x * k, y: v.y * k };
}
export function scaleVec2InPlace(out, k) {
    out.x *= k;
    out.y *= k;
    return out;
}
export function lenVec2(v) {
    return Math.hypot(v.x, v.y);
}
