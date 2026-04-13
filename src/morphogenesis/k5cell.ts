/**
 * K₅ Cell primitives.
 *
 * A K₅ cell is a complete graph on 5 nodes (10 members). For 5 points
 * in general position (no 4 coplanar), the equilibrium matrix has a
 * 1-dimensional null space, so the cell admits exactly one state of
 * self-stress up to scale — this is the analytical result captured
 * in Eq.(13) of Aloui et al. 2019.
 *
 * This file implements the spec's F2.2 (cell_self_stress) primitive.
 * The volume-ratio form of Eq.(13) is equivalent to computing the
 * null space of the K₅ equilibrium matrix, so we implement it that
 * way: the nullspace basis is exact (single RREF pass) and avoids
 * carrying all ten cofactor expressions by hand.
 */

import { Vec3 } from './types';
import { vol, isGeneralPosition, vdist } from './geometry';
import { nullspace } from './linalg';

// ─── K₅ edge enumeration ────────────────────────────────────────

/**
 * All 10 unordered pairs (i < j) of the 5 local indices, in
 * lexicographic order. Edge 0 = (0,1), edge 9 = (3,4).
 */
export function k5EdgePairs(): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) pairs.push([i, j]);
  }
  return pairs;
}

// ─── F2.2 — cell_self_stress(cell_id, α) ────────────────────────

/**
 * Compute the self-stress of a K₅ cell in closed form.
 *
 * The 10 returned values are force densities q_ij = w_ij / L_ij,
 * ordered to match k5EdgePairs(). For points in general position
 * this is the unique (up to sign / scale) 1D null-space direction
 * of the K₅ equilibrium matrix, which is what Eq.(13) writes as
 * a ratio of tetrahedral volumes.
 *
 * @param points  five positions in general position
 * @param alpha   overall scale (default 1); the sign chooses which
 *                of the two complementary sign patterns is used
 * @returns       10 force densities, or null if points are degenerate
 */
export function cellSelfStress(points: Vec3[], alpha: number = 1): number[] | null {
  if (points.length !== 5) return null;
  if (!isGeneralPosition(points)) return null;

  const pairs = k5EdgePairs();

  // Build the 15×10 equilibrium matrix A directly. Eq.(13) of Aloui
  // et al. gives w_ij = α * f(·,·,·,·) / f(·,·,·,·); the null-space
  // of A is that same 1D line. We read it off numerically.
  const A: number[][] = Array.from({ length: 15 }, () => new Array(10).fill(0));
  for (let e = 0; e < 10; e++) {
    const [ni, nj] = pairs[e];
    const pi = points[ni], pj = points[nj];
    const dx = pj[0] - pi[0], dy = pj[1] - pi[1], dz = pj[2] - pi[2];
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-15) return null;
    A[3 * ni + 0][e] =  dx / L; A[3 * ni + 1][e] =  dy / L; A[3 * ni + 2][e] =  dz / L;
    A[3 * nj + 0][e] = -dx / L; A[3 * nj + 1][e] = -dy / L; A[3 * nj + 2][e] = -dz / L;
  }

  const basis = nullspace(A);
  if (basis.length === 0) return null;

  // Convert axial forces t to force densities q = t / L, apply α.
  const t = basis[0];
  const q = new Array(10).fill(0);
  for (let e = 0; e < 10; e++) {
    const [ni, nj] = pairs[e];
    const L = vdist(points[ni], points[nj]);
    q[e] = alpha * t[e] / L;
  }
  return q;
}

/**
 * Sanity check: the K₅ self-stress of 5 points in general position
 * must have a 6+/4− (or 4+/6−) sign pattern.
 */
export function classifySignPattern(w: number[]): 'typeI' | 'typeII' {
  const nPos = w.filter(v => v > 0).length;
  return nPos >= 6 ? 'typeI' : 'typeII';
}

/**
 * Convenience: compute the volume ratio that Eq.(13) uses to set
 * w_{P_a P_b}. Exposed for tests / diagnostics; the main path uses
 * cellSelfStress() above.
 */
export function volumeRatio(pa: Vec3, pb: Vec3, pc: Vec3, pd: Vec3, pe: Vec3): number {
  const num = vol(pa, pb, pc, pd);
  const den = vol(pa, pc, pd, pe);
  return den === 0 ? 0 : num / den;
}
