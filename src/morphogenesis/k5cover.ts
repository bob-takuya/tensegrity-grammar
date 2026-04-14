/**
 * Sub.B — BUILD_K5_COVER (strutness-driven incremental attachment)
 *
 * Given a point set P, return an ordered list of K₅ cell definitions
 * such that every point is in at least one cell and every cell
 * (except the seed) shares 3 or 4 nodes with the union of the cells
 * that precede it. The output drives `buildStructureFromCover` in
 * `searchClass1.ts`.
 *
 * Design history:
 *   spec v1 — Delaunay tetrahedralisation. Optimises edge length
 *             (outer sphere minimisation) which is the wrong
 *             objective for tensegrity: it preferentially omits
 *             the LONGEST edges, i.e. the natural strut candidates.
 *             Triplex lost the C-D strut and canonical Class-1
 *             became unreachable.
 *   spec v2 — Auxiliary K₅ cells to inject arbitrary strut edges.
 *             Abandoned after an empirical test showed aux-point
 *             adhesion + fusion is an identity operation on
 *             existing edges: the aux self-stress column is the
 *             only one that touches the aux edges, so the first
 *             fuseSelfStress drops it as pivot and the "strut
 *             signature" the scheme tried to inject disappears
 *             together with the aux column.
 *   spec v3 — this file. Keep the K₅ cover on input points only,
 *             but change the *selection rule* from "nearest to
 *             centroid / nearest to covered" to "most strut-like
 *             edges first". Simple greedy wins because strut
 *             candidates are long edges and a Delaunay-style
 *             short-edge-first objective actively works against
 *             us.
 *
 * Algorithm (this file):
 *
 *   1. Rank every pair (i, j) by strutness (default: pair distance).
 *      The top ⌊n/2⌋ pairs are the "strut candidates" — edges the
 *      downstream Phase 3 LP will try to mark as struts.
 *   2. Seed the cover starting from the longest pair (guaranteed to
 *      be a strut candidate) and greedily add three more input
 *      points. Each addition maximises distance-from-{a,b} so the
 *      seed covers as much of the point cloud as possible while
 *      staying in general position.
 *   3. Iteratively attach the remaining uncovered points. For each
 *      uncovered v, try share-4 attachment first, then share-3. For
 *      every candidate cell we compute SCORE(cell) = Σ 1/(rank+1)
 *      over the 10 K₅ edges and keep the globally best attachment
 *      across all uncovered v's. This rewards cells that contain
 *      many strut candidates without needing an explicit "omit
 *      strut" filter.
 */

import { Vec3 } from './types';
import { vol } from './geometry';

export interface K5CoverEntry {
  /** Indices into the original point array that are shared with
   *  the union of previously-placed cells. Empty for the seed. */
  sharedIdx: number[];
  /** Indices into the original point array that are introduced
   *  for the first time by this cell. For the seed, this is the
   *  5-point K₅. For share-4 adhesions, exactly one index; for
   *  share-3 adhesions, two. */
  newIdx: number[];
}

/** Legacy alias for the internal cover-cell shape. */
export type CoverCell = K5CoverEntry;

export interface K5CoverOptions {
  /**
   * Strutness function used to rank candidate strut edges. The
   * default is straight Euclidean distance — long edges rank high
   * and the greedy attachment prefers cells that contain them. If
   * the caller has a current W matrix they can pass a custom
   * function that uses max_j(-W[e,j]), i.e. the most negative
   * self-stress assignment to that edge.
   */
  strutnessFn?: (i: number, j: number, P: Vec3[]) => number;
  /** General-position tolerance on |vol(P_i,P_j,P_k,P_l)|. */
  volTol?: number;
  /**
   * Share-count preference order when growing the cover. The
   * builder tries each count left-to-right and accepts the first
   * one that admits a general-position cell. Default [4, 3].
   */
  preferredShareCounts?: number[];
  /**
   * Which entry in the strutness-ranked pair list to use as the
   * seed's first edge. `0` = longest pair (default; matches
   * canonical Aloui behaviour). `1` = second-longest, etc. The
   * beam-search driver in `searchClass1.ts` uses higher values to
   * enumerate *different* covers when the first one fails to
   * yield a Class-1 tensegrity.
   */
  seedRank?: number;
}

// ─── Geometric helpers ────────────────────────────────────────

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Check that every 4-subset of `idxs` has non-zero tetrahedral
 * volume (|vol| > `tol`). A K₅ cell needs this property for the
 * engine's self-stress construction to be well-conditioned.
 */
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

// ─── Strut ranking ────────────────────────────────────────────

interface StrutRank {
  /** Pairs sorted by strutness descending. */
  ordered: Array<{ i: number; j: number; score: number }>;
  /** Rank lookup: pairKey → 0-based position in `ordered`. */
  rankOf: Map<string, number>;
}

function buildStrutRank(
  P: Vec3[],
  strutnessFn: (i: number, j: number, P: Vec3[]) => number,
): StrutRank {
  const n = P.length;
  const ordered: Array<{ i: number; j: number; score: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      ordered.push({ i, j, score: strutnessFn(i, j, P) });
    }
  }
  // Sort descending by strutness, with an explicit index-based
  // tiebreak so the strictly-symmetric Triplex (where three pairs
  // have algebraically identical distances but differ by a single
  // ULP in IEEE float) always yields the same cover.
  ordered.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 1e-9) return diff;
    if (a.i !== b.i) return a.i - b.i;
    return a.j - b.j;
  });
  const rankOf = new Map<string, number>();
  ordered.forEach((entry, idx) => rankOf.set(pairKey(entry.i, entry.j), idx));
  return { ordered, rankOf };
}

/**
 * SCORE(entry) weights two signals:
 *   (1) number of strut candidates contained, i.e. edges whose
 *       rank is in the top ⌊n/2⌋, and
 *   (2) Σ 1/(rank+1) over all 10 K₅ edges.
 *
 * The strut-candidate count dominates (×1000) so two cells with
 * different numbers of struts are always separable, and the
 * 1/(rank+1) sum is a secondary tiebreaker that still prefers
 * cells containing longer non-strut edges.
 *
 * The pure inverse-rank sum on its own is too coarse to separate
 * two cells that contain the same number of struts at similar
 * ranks — on the 6-point Triplex the two candidate last cells
 *   {A,B,C,D,E}   (contains A-E, C-D)
 *   {B,C,D,E,F}   (contains B-F, C-D)
 * scored within 0.5% of each other, and a stable-sort tiebreaker
 * was arbitrarily picking the second even though both options
 * miss exactly one of the three canonical struts — we needed an
 * outside-of-cell "did any strut get left behind" signal too,
 * which the caller supplies via `strutsNotYetCovered`.
 */
function scoreEntry(
  entry: K5CoverEntry,
  rank: StrutRank,
  topK: number,
  strutsNotYetCovered: Set<string>,
): number {
  const pts = [...entry.sharedIdx, ...entry.newIdx];
  let strutCount = 0;
  let newStrutCount = 0;
  let inverseRankSum = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const key = pairKey(pts[i], pts[j]);
      const r = rank.rankOf.get(key);
      if (r !== undefined) {
        inverseRankSum += 1 / (r + 1);
        if (r < topK) {
          strutCount++;
          // Struts still missing from the cover union score
          // EXTRA — adding a brand-new strut is worth more than
          // repeating one that's already been covered.
          if (strutsNotYetCovered.has(key)) newStrutCount++;
        }
      }
    }
  }
  return newStrutCount * 1e6 + strutCount * 1e3 + inverseRankSum;
}

// ─── Seed selection ───────────────────────────────────────────

/**
 * Seed selection. Start from the longest pair at `seedRank` in the
 * strutness-ordered list and greedily add three more points, each
 * time picking the covered-space point that is farthest from both
 * a and b (maximises distance-sum) while preserving general
 * position of the growing seed.
 *
 * `seedRank = 0` uses the canonical longest pair; higher values
 * let `enumerateDiverseCovers` generate covers starting from
 * alternative first edges so the outer beam search can try
 * several fundamentally different W-column spans.
 */
function findSeed(
  P: Vec3[],
  rank: StrutRank,
  volTol: number,
  seedRank: number = 0,
): number[] {
  const n = P.length;
  if (n < 5) throw new Error('K₅ cover requires n ≥ 5');

  const idx = Math.max(0, Math.min(seedRank, rank.ordered.length - 1));
  const first = rank.ordered[idx];
  const seed: number[] = [first.i, first.j];

  // Ranked pool of the remaining points by distance-from-{a,b}.
  const pool = [...Array(n).keys()]
    .filter(k => k !== first.i && k !== first.j)
    .map(k => ({
      k,
      d: dist(P[k], P[first.i]) + dist(P[k], P[first.j]),
    }))
    .sort((a, b) => b.d - a.d)
    .map(x => x.k);

  for (const c of pool) {
    const trial = [...seed, c];
    if (trial.length >= 4 && !inGeneralPosition(P, trial, volTol)) continue;
    seed.push(c);
    if (seed.length === 5) break;
  }

  if (seed.length < 5) {
    // Last-ditch: some point fails general position for every
    // prefix; walk through the full pool again without the guard
    // and accept whatever we get. For reasonable inputs this
    // branch is unreachable.
    for (const c of pool) {
      if (seed.includes(c)) continue;
      seed.push(c);
      if (seed.length === 5) break;
    }
  }
  if (seed.length < 5) {
    throw new Error('cannot find 5-point general-position seed');
  }
  return seed;
}

// ─── Attachment ───────────────────────────────────────────────

/**
 * Find one K₅ attachment for uncovered node `v` that shares exactly
 * `nShared` points with the current covered set. Returns `null` if
 * no general-position cell exists for the requested share count.
 *
 * The inner loop enumerates candidate shared subsets in an order
 * that biases toward subsets containing strut-rank-high edges,
 * which lets the outer SCORE-based selection converge quickly.
 */
function findAttachment(
  P: Vec3[],
  v: number,
  covered: number[],
  uncovered: number[],
  nShared: number,
  rank: StrutRank,
  topK: number,
  strutsLeft: Set<string>,
  volTol: number,
): K5CoverEntry | null {
  const nNewExtras = 5 - nShared - 1; // 5-point cell minus shared minus v

  if (nNewExtras === 0) {
    // share-4: shared subset + v, no extra new points.
    // Rank covered subsets by how many strut-candidate edges the
    // resulting K₅ would contain, so the outer SCORE-max finds a
    // high-quality cell on its first accepted candidate.
    const subsets = combinations(covered, nShared);
    const scored = subsets.map(sub => {
      const cell = { sharedIdx: sub, newIdx: [v] };
      return { sub, s: scoreEntry(cell, rank, topK, strutsLeft) };
    });
    scored.sort((a, b) => b.s - a.s);
    for (const { sub } of scored) {
      const trial = [...sub, v];
      if (!inGeneralPosition(P, trial, volTol)) continue;
      return { sharedIdx: sub, newIdx: [v] };
    }
    return null;
  }

  // share-3 (nNewExtras = 1): shared subset of 3 + v + one more
  // uncovered input point. The extra uncovered point is chosen
  // from the current uncovered pool; each combination is scored
  // and the highest-scoring general-position cell wins.
  const pool = uncovered.filter(u => u !== v);
  const sharedSubsets = combinations(covered, nShared);

  let bestCell: K5CoverEntry | null = null;
  let bestScore = -Infinity;
  for (const sub of sharedSubsets) {
    for (const extras of combinations(pool, nNewExtras)) {
      const trial = [...sub, ...extras, v];
      if (!inGeneralPosition(P, trial, volTol)) continue;
      const cell: K5CoverEntry = {
        sharedIdx: sub,
        newIdx: [...extras, v],
      };
      const s = scoreEntry(cell, rank, topK, strutsLeft);
      if (s > bestScore) {
        bestScore = s;
        bestCell = cell;
      }
    }
  }
  return bestCell;
}

// ─── Public entry point ───────────────────────────────────────

export function buildK5Cover(
  P: Vec3[],
  options: K5CoverOptions = {},
): K5CoverEntry[] {
  const n = P.length;
  if (n < 5) throw new Error('K₅ cover requires n ≥ 5');

  const volTol = options.volTol ?? 1e-9;
  const preferredShareCounts = options.preferredShareCounts ?? [4, 3];
  const strutnessFn = options.strutnessFn
    ?? ((i, j, Pts) => dist(Pts[i], Pts[j]));

  const rank = buildStrutRank(P, strutnessFn);
  // Top ⌊n/2⌋ pairs are the "strut candidates". We maintain the
  // set of strut candidates NOT YET covered by any placed cell so
  // the SCORE function can reward cells that add a brand-new
  // strut over cells that only duplicate an already-covered one.
  const topK = Math.max(1, Math.floor(n / 2));
  const strutsLeft = new Set<string>();
  for (let i = 0; i < topK && i < rank.ordered.length; i++) {
    const p = rank.ordered[i];
    strutsLeft.add(pairKey(p.i, p.j));
  }

  // Helper: mark every strut contained in `cell` as covered.
  const markStrutsCovered = (cell: K5CoverEntry): void => {
    const pts = [...cell.sharedIdx, ...cell.newIdx];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const k = pairKey(pts[i], pts[j]);
        if (strutsLeft.has(k)) strutsLeft.delete(k);
      }
    }
  };

  // Step 1 + 2: seed.
  const seed = findSeed(P, rank, volTol, options.seedRank ?? 0);
  const seedCell: K5CoverEntry = { sharedIdx: [], newIdx: seed };
  const cover: K5CoverEntry[] = [seedCell];
  const covered = new Set<number>(seed);
  markStrutsCovered(seedCell);

  // Step 3: grow the cover one attachment at a time. At every step
  // we pick the attachment with the highest strut-sensitive score
  // across all possible (uncovered vertex, share count) pairs.
  while (covered.size < n) {
    const coveredArr = [...covered];
    const uncovered: number[] = [];
    for (let i = 0; i < n; i++) if (!covered.has(i)) uncovered.push(i);

    let bestCell: K5CoverEntry | null = null;
    let bestScore = -Infinity;
    for (const v of uncovered) {
      for (const share of preferredShareCounts) {
        const cell = findAttachment(
          P, v, coveredArr, uncovered, share, rank, topK, strutsLeft, volTol,
        );
        if (cell) {
          const s = scoreEntry(cell, rank, topK, strutsLeft);
          if (s > bestScore) {
            bestScore = s;
            bestCell = cell;
          }
          // Once share-4 returned something for this v we stop
          // trying share-3: share-4 always has a higher Δ(dim W)
          // / cost ratio, so we never want to prefer share-3 over
          // share-4 for the same v.
          break;
        }
      }
    }

    if (!bestCell) {
      // No attachment possible within the preferred share counts.
      // Fall back to "attach the first uncovered point via the
      // 4 covered points closest to it, ignoring general position"
      // — same last-ditch as the previous implementation.
      const v = uncovered[0];
      const ordered = coveredArr
        .map(c => ({ c, d: dist(P[v], P[c]) }))
        .sort((a, b) => a.d - b.d)
        .map(x => x.c);
      bestCell = {
        sharedIdx: ordered.slice(0, 4),
        newIdx: [v],
      };
    }

    cover.push(bestCell);
    markStrutsCovered(bestCell);
    for (const x of bestCell.newIdx) covered.add(x);
  }

  return cover;
}

// ─── Diverse cover enumeration ────────────────────────────────

/**
 * Build a collection of *diverse* K₅ covers for the same input
 * points. The beam-search driver in `searchClass1.ts` iterates
 * through these in order, trying each one as the Phase 2 base
 * before giving up. Diversity comes from two sources:
 *
 *   1. `seedRank = 0, 1, 2, ...` — the first edge of the seed
 *      is pulled from successively lower positions in the
 *      strutness ranking, which generally steers the incremental
 *      attachment toward different 5-subsets.
 *   2. Signature-based de-duplication — two covers that produce
 *      the same *edge set* (as a sorted list of `i-j` keys) are
 *      treated as identical and only one copy is kept. This
 *      prevents the enumeration from wasting time on cosmetic
 *      permutations of the same cover.
 *
 * Returns at most `maxCandidates` entries; stops early if the
 * seed-rank loop has exhausted every pair in the strutness list.
 */
export function enumerateDiverseCovers(
  P: Vec3[],
  maxCandidates: number = 8,
  options: Omit<K5CoverOptions, 'seedRank'> = {},
): K5CoverEntry[][] {
  const out: K5CoverEntry[][] = [];
  const seen = new Set<string>();

  const n = P.length;
  const totalPairs = (n * (n - 1)) / 2;
  const maxSeedRank = Math.min(totalPairs, maxCandidates * 3);

  for (let r = 0; r < maxSeedRank && out.length < maxCandidates; r++) {
    let cover: K5CoverEntry[];
    try {
      cover = buildK5Cover(P, { ...options, seedRank: r });
    } catch {
      continue;
    }
    const sig = coverSignature(cover);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(cover);
  }

  if (out.length === 0) {
    // Last-ditch: at least one cover, however bad.
    out.push(buildK5Cover(P, { ...options, seedRank: 0 }));
  }

  return out;
}

function coverSignature(cover: K5CoverEntry[]): string {
  const edges: string[] = [];
  for (const cell of cover) {
    const nodes = [...cell.sharedIdx, ...cell.newIdx].sort((a, b) => a - b);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        edges.push(`${nodes[i]}-${nodes[j]}`);
      }
    }
  }
  edges.sort();
  return edges.join(',');
}
