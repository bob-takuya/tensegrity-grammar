/**
 * 3D geometry primitives for tensegrity morphogenesis.
 */

import { Vec3 } from './types';

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vscale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vcross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vlength(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function vnormalize(v: Vec3): Vec3 {
  const l = vlength(v);
  return l > 1e-15 ? vscale(v, 1 / l) : [0, 0, 0];
}

export function vdist(a: Vec3, b: Vec3): number {
  return vlength(vsub(b, a));
}

/**
 * Signed volume of tetrahedron (P0, P1, P2, P3).
 *
 * V = (1/6) det | P1-P0  P2-P0  P3-P0 |
 *
 * This is the fundamental quantity for K₅ self-stress computation
 * (Equation 13 in Aloui et al. 2019).
 */
export function signedTetraVolume(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const a = vsub(p1, p0);
  const b = vsub(p2, p0);
  const c = vsub(p3, p0);
  return vdot(a, vcross(b, c)) / 6;
}

/**
 * Check general position: no 4 points are coplanar.
 * For 5 points, check all C(5,4) = 5 subsets of 4 points.
 * Returns true if ALL subsets have non-zero volume (general position).
 */
export function isGeneralPosition(points: Vec3[], eps: number = 1e-10): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let l = k + 1; l < n; l++) {
          const vol = Math.abs(signedTetraVolume(points[i], points[j], points[k], points[l]));
          if (vol < eps) return false;
        }
      }
    }
  }
  return true;
}
