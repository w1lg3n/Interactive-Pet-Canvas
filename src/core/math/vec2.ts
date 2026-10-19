/**
 * Minimal 2D vector toolkit.
 *
 * Every operation writes into an `out` parameter instead of returning a new object, so the
 * render loop can reuse preallocated vectors and never allocate per frame (no GC pauses).
 */
export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

/** out = a + b * s */
export function addScaled(out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  return out;
}

export const length = (a: Vec2): number => Math.hypot(a.x, a.y);

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Normalises `a` into `out`; a zero vector stays zero instead of becoming NaN. */
export function normalize(out: Vec2, a: Vec2): Vec2 {
  const len = Math.hypot(a.x, a.y);
  if (len < 1e-9) return set(out, 0, 0);
  out.x = a.x / len;
  out.y = a.y / len;
  return out;
}

export function lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

/** Rotates `a` by `angle` radians (clockwise on screen, since canvas y points down). */
export function rotate(out: Vec2, a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = a.x * c - a.y * s;
  const y = a.x * s + a.y * c;
  out.x = x;
  out.y = y;
  return out;
}

/** Sets `out` to a point at `angle` and `dist` from `origin`. */
export function polar(out: Vec2, origin: Vec2, angle: number, dist: number): Vec2 {
  out.x = origin.x + Math.cos(angle) * dist;
  out.y = origin.y + Math.sin(angle) * dist;
  return out;
}

export const angleOf = (from: Vec2, to: Vec2): number => Math.atan2(to.y - from.y, to.x - from.x);
