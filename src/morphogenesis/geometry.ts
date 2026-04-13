/**
 * 3D geometry primitives for cellular morphogenesis.
 *
 * The central quantity is the signed volume of a tetrahedron — the
 * analytical self-stress of a K₅ cell (Eq.(13) of Aloui et al. 2019)
 * is a ratio of such volumes.
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
 * F2.1 — Signed volume of a tetrahedron (P_i, P_j, P_k, P_l).
 *
 *   f(P_i, P_j, P_k, P_l) = (1/6) * det | 1  x_i  y_i  z_i |
 *                                       | 1  x_j  y_j  z_j |
 *                                       | 1  x_k  y_k  z_k |
 *                                       | 1  x_l  y_l  z_l |
 *
 * This is the building block of the K₅ self-stress in Eq.(13).
 */
export function vol(pi: Vec3, pj: Vec3, pk: Vec3, pl: Vec3): number {
  const a = vsub(pj, pi);
  const b = vsub(pk, pi);
  const c = vsub(pl, pi);
  return vdot(a, vcross(b, c)) / 6;
}

/** Alias retained for call-sites that already use `signedTetraVolume`. */
export const signedTetraVolume = vol;

/**
 * General-position test: for 5 points, every 4-subset must have
 * non-zero tetrahedral volume. This is the pre-condition for a
 * unique 1D self-stress on K₅.
 */
export function isGeneralPosition(points: Vec3[], eps: number = 1e-10): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let l = k + 1; l < n; l++) {
          if (Math.abs(vol(points[i], points[j], points[k], points[l])) < eps) return false;
        }
      }
    }
  }
  return true;
}
