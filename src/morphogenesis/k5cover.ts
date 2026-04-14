/**
 * Sub.B — BUILD_K5_COVER (incremental attachment)
 *
 * Given a point set P we need an ordered list of K₅ cell definitions
 * such that every point is in at least one cell and every cell
 * (except the seed) shares 3 or 4 nodes with the union of the cells
 * that precede it. The output drives `buildStructureFromCover` in
 * `searchClass1.ts`.
 *
 * Why not Delaunay / centroid-distance greedy
 * ──────────────────────────────────────────
 * An earlier version seeded the cover with "the 5 points closest
 * to the centroid" and attached each uncovered point via "the 4
 * closest covered points". That heuristic solves a different
 * problem — minimise edge length — and produces covers that
 * accidentally OMIT the longest edges. In a tensegrity the
 * long edges are the struts, so omitting them makes canonical
 * Class-1 structures unreachable.
 *
 * Concrete failure on the Triplex 6-point layout:
 *   - Canonical Aloui §5 cover:  {A,B,C,D,E} + {B,C,D,E,F},
 *     omitted edge A-F (a medium "90° diagonal", not a strut).
 *   - Distance greedy:           {A,B,D,E,F} + {A,B,C,E,F},
 *     omitted edge C-D (the LONGEST edge — a canonical strut).
 *   The second cover has no C-D member at all, so the algorithm
 *   literally cannot produce the canonical Triplex {A-E, C-D, B-F}
 *   strut set no matter how smart the Phase 3 LP becomes.
 *
 * New strategy: strut-preserving incremental cover
 * ────────────────────────────────────────────────
 * 1. Compute every pair distance. The top ⌊n/2⌋ longest pairs are
 *    our "strut candidates" — any of them might end up as a strut
 *    in the final tensegrity.
 * 2. Seed = 5 nodes that contain as many strut-candidate endpoints
 *    as possible, ties broken by total pairwise distance and
 *    general-position feasibility.
 * 3. Attachment = find an uncovered point v and a 4-subset of
 *    already-covered nodes such that
 *      (a) the 5-tuple (subset ∪ {v}) is in general position, AND
 *      (b) the "omitted pair" — the covered node EXCLUDED from the
 *          subset, paired with v — is NOT a strut candidate.
 *    Condition (b) guarantees no strut is ever split between
 *    different cells during the incremental build, because the
 *    only bottom-top pair the attachment could "cut" is that
 *    omitted pair.
 * 4. Fall back to "share-3" (2 new nodes) when share-4 can't be
 *    satisfied.
 *
 * For the Triplex 6-point layout this yields the canonical cover
 * {A,B,C,D,E} + {B,C,D,E,F} automatically; the greedy LP phase
 * can then discover the A-E / C-D / B-F strut set the paper
 * describes.
 */

import { Vec3 } from './types';
import { vol } from './geometry';

export interface CoverCell {
  sharedIdx: number[]; // indices into the original point array
  newIdx: number[];
}

export interface K5CoverOptions {
  /**
   * Share-count preference order when growing the cover. The
   * builder tries each count left-to-right and accepts the first
   * one that admits a general-position, strut-preserving cell.
   * Default [4, 3].
   */
  preferredShareCounts?: number[];
  /** General-position tolerance on |vol(P_i,P_j,P_k,P_l)|. */
  volTol?: number;
  /**
   * Fraction of the longest pairs marked as strut candidates.
   * With n = 6 and default `strutFraction = 0.5` we get ⌊6/2⌋ = 3
   * strut candidates — exactly the three 150°-offset bottom-top
   * diagonals in the Triplex layout. Larger fractions keep more
   * edges "off-limits" for cutting.
   */
  strutFraction?: number;
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function inGeneralPosition(P: Vec3[], idxs: number[], tol: number): boolean {
  for (let i = 0; i < idxs.length; i++) {
    for (let j = i + 1; j < idxs.length; j++) {
      for (let k = j + 1; k < idxs.length; k++) {
        for (let l = k + 1; l < idxs.length; l++) {
          if (Math.abs(vol(P[idxs[i]], P[idxs[j]], P[idxs[k]], P[idxs[l]])) < tol) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function combinations<T>(arr: T[], r: number): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  if (r > n || r < 0) return out;
  if (r === 0) return [[]];
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

/**
 * Rank all unordered pairs by distance descending. Returns both
 * the sorted list and a `Set<string>` of the top-k pair keys, so
 * callers can check strut membership in O(1).
 */
function computeStrutCandidates(
  P: Vec3[],
  fraction: number,
): { pairOrder: Array<{ i: number; j: number; d: number }>; strutSet: Set<string> } {
  const n = P.length;
  const pairOrder: Array<{ i: number; j: number; d: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairOrder.push({ i, j, d: dist(P[i], P[j]) });
    }
  }
  pairOrder.sort((a, b) => b.d - a.d);

  const k = Math.max(1, Math.floor(n * fraction));
  const strutSet = new Set<string>();
  for (let i = 0; i < Math.min(k, pairOrder.length); i++) {
    strutSet.add(pairKey(pairOrder[i].i, pairOrder[i].j));
  }
  return { pairOrder, strutSet };
}

/**
 * Seed selection: pick 5 nodes that contain as many strut-candidate
 * endpoints as possible, with general-position ties broken by the
 * strutness-weighted priority defined inside.
 *
 * We start from the longest pair (guaranteed to be a strut
 * candidate) and greedily add nodes that maximise the number of
 * strut candidates whose BOTH endpoints end up in the seed.
 */
function findSeedK5(
  P: Vec3[],
  pairOrder: Array<{ i: number; j: number; d: number }>,
  strutSet: Set<string>,
  volTol: number,
): number[] {
  const n = P.length;
  if (n < 5) throw new Error('K₅ cover requires n ≥ 5');

  // Start from the longest edge; that pair is a strut candidate.
  const first = pairOrder[0];
  const seed: number[] = [first.i, first.j];

  const scoreAddition = (v: number): number => {
    // Count how many strut-candidate edges would become intra-seed
    // after adding `v` (each needs its other endpoint already in
    // the seed). Tiebreak by total distance from seed.
    let strutGain = 0;
    let distSum = 0;
    for (const s of seed) {
      if (strutSet.has(pairKey(v, s))) strutGain++;
      distSum += dist(P[v], P[s]);
    }
    return strutGain * 1e6 + distSum;
  };

  while (seed.length < 5) {
    let bestV = -1;
    let bestScore = -Infinity;
    for (let v = 0; v < n; v++) {
      if (seed.includes(v)) continue;
      const trial = [...seed, v];
      if (trial.length >= 4 && !inGeneralPosition(P, trial, volTol)) continue;
      const s = scoreAddition(v);
      if (s > bestScore) { bestScore = s; bestV = v; }
    }
    if (bestV < 0) {
      // Fall back to any valid point even if it breaks general
      // position so we can at least return a seed.
      for (let v = 0; v < n; v++) {
        if (!seed.includes(v)) { bestV = v; break; }
      }
      if (bestV < 0) break;
    }
    seed.push(bestV);
  }
  return seed;
}

/**
 * Find one K₅ attachment for uncovered node `v`. `covered` is the
 * full set of already-covered nodes. `shareCount` is 4 (add 1 new)
 * or 3 (add 2 new). We require general position on the resulting
 * 5-tuple AND that the "omitted pair" — the covered node NOT
 * selected as a shared neighbour, paired with v — is not one of
 * the strut candidates. Falling back to share-3 we relax the
 * strut-preservation rule because 2 new nodes are added together
 * and the omitted-pair analysis no longer applies cleanly.
 */
function findAttachment(
  P: Vec3[],
  v: number,
  covered: number[],
  uncovered: number[],
  strutSet: Set<string>,
  shareCount: number,
  volTol: number,
): CoverCell | null {
  if (shareCount === 4) {
    // Order covered nodes by proximity to v — try "natural" 4-subsets
    // first so simple cases don't need to enumerate the whole space.
    const ordered = [...covered].sort((a, b) =>
      dist(P[v], P[a]) - dist(P[v], P[b]),
    );

    for (const subset of combinations(ordered, 4)) {
      const trial = [...subset, v];
      if (!inGeneralPosition(P, trial, volTol)) continue;
      // Check: the covered node EXCLUDED from the subset is the
      // seed's "unique partner" of v in the new cell pair. If that
      // pair is a strut candidate, we'd be omitting a strut from
      // the union — skip.
      const cutVertices = covered.filter(c => !subset.includes(c));
      const anyCut = cutVertices.some(c => strutSet.has(pairKey(v, c)));
      if (anyCut) continue;
      return { sharedIdx: subset, newIdx: [v] };
    }
    // If strut preservation made everything impossible, relax and
    // take any valid share-4 attachment.
    for (const subset of combinations(ordered, 4)) {
      const trial = [...subset, v];
      if (!inGeneralPosition(P, trial, volTol)) continue;
      return { sharedIdx: subset, newIdx: [v] };
    }
    return null;
  }

  if (shareCount === 3) {
    // share-3 = 3 shared + 2 new. We pick `v` plus one other
    // uncovered partner w and search for 3 shared nodes.
    for (const w of uncovered) {
      if (w === v) continue;
      const pair = [v, w];
      const ordered = [...covered].sort((a, b) =>
        dist(P[v], P[a]) - dist(P[v], P[b]),
      );
      for (const subset of combinations(ordered, 3)) {
        const trial = [...subset, ...pair];
        if (!inGeneralPosition(P, trial, volTol)) continue;
        return { sharedIdx: subset, newIdx: pair };
      }
    }
    return null;
  }

  return null;
}

/**
 * Build an ordered K₅ cover using the strut-preserving incremental
 * algorithm described at the top of the file.
 */
export function buildK5Cover(
  P: Vec3[],
  options: K5CoverOptions = {},
): CoverCell[] {
  const n = P.length;
  if (n < 5) throw new Error('K₅ cover requires n ≥ 5');

  const preferredShareCounts = options.preferredShareCounts ?? [4, 3];
  const volTol = options.volTol ?? 1e-9;
  const strutFraction = options.strutFraction ?? 0.5;

  const { pairOrder, strutSet } = computeStrutCandidates(P, strutFraction);

  // Step 1: seed
  const seed = findSeedK5(P, pairOrder, strutSet, volTol);
  const cells: CoverCell[] = [{ sharedIdx: [], newIdx: seed }];
  const covered = new Set<number>(seed);

  // Step 2: iterate until every node is covered
  while (covered.size < n) {
    const coveredArr = [...covered];
    const uncovered: number[] = [];
    for (let i = 0; i < n; i++) if (!covered.has(i)) uncovered.push(i);

    // Try every uncovered node against every preferred share count.
    // Uncovered nodes are ordered by how many strut candidates they
    // would bring in — the more struts they unlock, the earlier we
    // want to attach them.
    const strutIncidence = (v: number): number => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        if (i === v) continue;
        if (strutSet.has(pairKey(v, i))) c++;
      }
      return c;
    };
    uncovered.sort((a, b) => strutIncidence(b) - strutIncidence(a));

    let attached: CoverCell | null = null;
    let attachedVs: number[] = [];
    outer: for (const share of preferredShareCounts) {
      for (const v of uncovered) {
        const cell = findAttachment(P, v, coveredArr, uncovered, strutSet, share, volTol);
        if (cell) {
          attached = cell;
          attachedVs = cell.newIdx;
          break outer;
        }
      }
    }

    if (!attached) {
      // Last-ditch: share the 4 closest-by-distance covered nodes to
      // the first uncovered point, ignoring the strut rule.
      const v = uncovered[0];
      const ordered = [...coveredArr].sort(
        (a, b) => dist(P[v], P[a]) - dist(P[v], P[b]),
      );
      attached = {
        sharedIdx: ordered.slice(0, 4),
        newIdx: [v],
      };
      attachedVs = [v];
    }

    cells.push(attached);
    for (const v of attachedVs) covered.add(v);
  }

  return cells;
}
