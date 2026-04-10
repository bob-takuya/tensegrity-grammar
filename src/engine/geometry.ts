import { Vec2 } from '../types';

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function dist(a: Vec2, b: Vec2): number {
  return length(sub(b, a));
}

export function angle(v: Vec2): number {
  return Math.atan2(v.y, v.x);
}

export function rotate(v: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function perp(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** Distance from point p to line segment ab */
export function pointToSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const t = Math.max(0, Math.min(1, dot(ap, ab) / dot(ab, ab)));
  const proj = add(a, scale(ab, t));
  return dist(p, proj);
}

/** Snap to grid */
export function snapToGrid(v: Vec2, gridSize: number): Vec2 {
  return {
    x: Math.round(v.x / gridSize) * gridSize,
    y: Math.round(v.y / gridSize) * gridSize,
  };
}
