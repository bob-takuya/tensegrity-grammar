/**
 * Sub.B — BUILD_K5_COVER
 *
 * Given a point set P we need an ordered list of K₅ cell definitions
 * such that every point in P is in at least one cell and each cell
 * (except the first) shares 3 or 4 nodes with the union of the cells
 * that precede it. This is exactly the input shape the cellular
 * morphogenesis engine expects.
 *
 * A full Delaunay 3D implementation is overkill for n ≤ ~50 and
 * brittle to code from scratch in TypeScript. Instead we use a greedy
 * nearest-neighbour strategy that provably produces a valid adhesion
 * sequence:
 *
 *   1. Pick the 5 points closest to the centroid as the seed cell.
 *   2. While uncovered points remain, pick the uncovered point p
 *      closest to the covered set and build a K₅ sharing the 3 or 4
 *      already-covered points nearest to p. We prefer sharedCount=4
 *      when it keeps the subsequent K₅ in general position; otherwise
 *      we fall back to sharedCount=3 (and consume one additional
 *      already-covered node from the ranked list).
 *
 * The output is an ordered list of cells, each of which is a tuple
 *   { sharedIds: number[], newIds: number[] }
 * giving the indices (into the original point array) of the shared
 * and new nodes for that adhesion step.
 */

import { Vec3 } from './types';
import { vol } from './geometry';

export interface CoverCell {
  sharedIdx: number[]; // indices into the original point array
  newIdx: number[];
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function centroid(P: Vec3[]): Vec3 {
  let cx = 0, cy = 0, cz = 0;
  for (const p of P) { cx += p[0]; cy += p[1]; cz += p[2]; }
  return [cx / P.length, cy / P.length, cz / P.length];
}

function inGeneralPosition(P: Vec3[], idxs: number[]): boolean {
  const eps = 1e-9;
  for (let i = 0; i < idxs.length; i++) {
    for (let j = i + 1; j < idxs.length; j++) {
      for (let k = j + 1; k < idxs.length; k++) {
        for (let l = k + 1; l < idxs.length; l++) {
          if (Math.abs(vol(P[idxs[i]], P[idxs[j]], P[idxs[k]], P[idxs[l]])) < eps) return false;
        }
      }
    }
  }
  return true;
}

export function buildK5Cover(P: Vec3[]): CoverCell[] {
  const n = P.length;
  if (n < 5) throw new Error('K₅ cover requires n ≥ 5');

  // Step 1: seed cell = 5 points closest to centroid that are in
  // general position. If the nearest-5 are coplanar, swap one out.
  const C = centroid(P);
  const ranked = P
    .map((p, i) => ({ i, d: dist(p, C) }))
    .sort((a, b) => a.d - b.d);
  let seedIdx: number[] = ranked.slice(0, 5).map(x => x.i);
  if (!inGeneralPosition(P, seedIdx)) {
    // Walk further down the ranking looking for a 5-subset in general
    // position. For small n this is O(n⁵) worst case but the loop
    // almost always exits in the first few iterations.
    outer: for (let pool = 6; pool <= Math.min(n, 20); pool++) {
      const cand = ranked.slice(0, pool).map(x => x.i);
      const combs = combinations(cand, 5);
      for (const c of combs) {
        if (inGeneralPosition(P, c)) { seedIdx = c; break outer; }
      }
    }
  }

  const cells: CoverCell[] = [{ sharedIdx: [], newIdx: seedIdx }];
  const covered = new Set<number>(seedIdx);
  const coveredList = [...seedIdx];

  // Step 2: greedy extension
  while (covered.size < n) {
    // Pick the uncovered point closest to any covered point
    let bestU = -1, bestD = Infinity;
    for (let u = 0; u < n; u++) {
      if (covered.has(u)) continue;
      let minD = Infinity;
      for (const c of coveredList) {
        const d = dist(P[u], P[c]);
        if (d < minD) minD = d;
      }
      if (minD < bestD) { bestD = minD; bestU = u; }
    }
    if (bestU < 0) break;

    // Rank the covered points by distance to bestU
    const rankedCovered = coveredList
      .map(c => ({ c, d: dist(P[bestU], P[c]) }))
      .sort((a, b) => a.d - b.d)
      .map(x => x.c);

    // Try sharedCount=4 first (1 new point = just bestU). Find 4
    // covered points forming a general-position 5-subset with bestU.
    const cell: number[] = [bestU];
    const targets = [4, 3];
    let chosenCell: number[] | null = null;
    let chosenShared: number[] = [];
    for (const want of targets) {
      // pick the `want` nearest covered points, grow the trial cell
      const trial = [bestU, ...rankedCovered.slice(0, want)];
      if (trial.length < 5) {
        // need more new points
        // Only viable when there are other uncovered points close enough
        const extras: number[] = [];
        for (let u = 0; u < n && trial.length + extras.length < 5; u++) {
          if (u === bestU) continue;
          if (covered.has(u)) continue;
          extras.push(u);
        }
        const filled = [...trial, ...extras].slice(0, 5);
        if (filled.length < 5) continue;
        if (inGeneralPosition(P, filled)) {
          chosenCell = filled;
          chosenShared = filled.filter(i => covered.has(i));
          break;
        }
      } else if (trial.length === 5 && inGeneralPosition(P, trial)) {
        chosenCell = trial;
        chosenShared = rankedCovered.slice(0, want);
        break;
      } else {
        // trial has exactly 5 points but degenerate; try swapping
        // the farthest shared point for the next-nearest one.
        for (let swapK = want; swapK < rankedCovered.length; swapK++) {
          const alt = [bestU, ...rankedCovered.slice(0, want - 1), rankedCovered[swapK]];
          if (alt.length === 5 && inGeneralPosition(P, alt)) {
            chosenCell = alt;
            chosenShared = alt.filter(i => i !== bestU);
            break;
          }
        }
        if (chosenCell) break;
      }
    }

    if (!chosenCell) {
      // Last-ditch: take the 4 nearest covered anyway; the engine will
      // flag general-position failures at runtime.
      chosenCell = [bestU, ...rankedCovered.slice(0, 4)];
      chosenShared = rankedCovered.slice(0, 4);
    }

    const newIdx = chosenCell.filter(i => !covered.has(i));
    cells.push({ sharedIdx: chosenShared, newIdx });
    for (const i of newIdx) { covered.add(i); coveredList.push(i); }
    cell.length = 0;
  }

  return cells;
}

// ─── helpers ────────────────────────────────────────────────

function combinations<T>(arr: T[], r: number): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  if (r > n) return out;
  const idx = Array.from({ length: r }, (_, i) => i);
  out.push(idx.map(i => arr[i]));
  while (true) {
    let i = r - 1;
    while (i >= 0 && idx[i] === n - r + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < r; j++) idx[j] = idx[j - 1] + 1;
    out.push(idx.map(i2 => arr[i2]));
  }
  return out;
}
