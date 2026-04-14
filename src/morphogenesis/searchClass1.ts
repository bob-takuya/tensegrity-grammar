/**
 * Class-1 Tensegrity Search Algorithm
 * ────────────────────────────────────
 * Given n points in ℝ³, searches for a Class-1 tensegrity on those
 * nodes. Theoretical basis: Aloui et al. (2019) cellular morphogenesis
 * + LP-based Class-1 enforcement + strategic fusion.
 *
 * Pipeline (cf. the spec in searchClass1.md):
 *   Phase 0  GENERATE_OR_VALIDATE_POINTS  (Sub.A)
 *   Phase 1  BUILD_K5_COVER               (Sub.B)  → k5cover.ts
 *   Phase 2  MORPHOGENESIS                (Sub.C)  → adhesion.ts
 *   Phase 3  ENFORCE_CLASS1               (Sub.D)  → lp.ts + fusion.ts
 *   Phase 4  validation
 *
 * The top-level entry point is *async*: the search chunks itself
 * across the event loop so the browser can redraw the viewer after
 * every significant step, and it is governed by a wall-clock deadline
 * instead of a fixed iteration budget.
 *
 * Every interesting event is pushed to state.events so the UI can
 * replay the search in real time.
 */

import { MorphogenesisState, Vec3 } from './types';
import {
  createEmptyState,
  deepCloneState,
  initializeK5,
  logEvent,
  assignForceDensities,
} from './engine';
import { adhereCell, suggestNewPositions } from './adhesion';
import { fuseOneEdge } from './fusion';
import {
  buildK5Cover,
  enumerateDiverseCovers,
  K5CoverEntry,
} from './k5cover';
import { buildEquilibriumMatrix, nullspace, symmetricEigenvalues } from './linalg';
import {
  lpClass1Check,
  lpClass1CheckAsync,
  lpPairCheck,
  LPCheckResult,
} from './lp';
import { greedyMatching, perturbMatching, Edge } from './matching';
import { vol } from './geometry';

// ─── Search driver / progress plumbing ─────────────────────

/**
 * A single tick emitted by the search. Consumers (UI / tests) use
 * this to render intermediate state without having to know anything
 * about the internal algorithm structure.
 */
export interface SearchProgress {
  /** Coarse phase label, suitable for a status line. */
  phase: string;
  /** Monotonic tick counter; useful as a React dependency. */
  tick: number;
  /** Wall-clock milliseconds since the search started. */
  elapsedMs: number;
  /** Remaining budget (ms). Negative means past the deadline. */
  remainingMs: number;
  /** True once the deadline has been reached — loops observe this. */
  deadlineReached: boolean;
  /**
   * Live reference to the mutable morphogenesis state. The caller
   * MAY read from it but MUST NOT mutate it; treat it as a view.
   * Because the search mutates the same object throughout, this
   * reference is stable for the whole run.
   */
  state: MorphogenesisState;
}

export interface Class1SearchOptions {
  /** Wall-clock budget for the whole search. Default 10 s. */
  timeoutMs?: number;
  /** Called after every significant mutation of `state`. */
  onProgress?: (progress: SearchProgress) => void;
  /**
   * Optional caller-controlled cancel signal. When aborted, the
   * current phase completes and the search returns what it has.
   */
  signal?: AbortSignal;
  /**
   * When true (the default in UI flows) the driver awaits a macrotask
   * between ticks so React can re-render and the browser can paint.
   * Set to false from Node test scripts to run at full speed.
   */
  yieldToEventLoop?: boolean;
  /**
   * How many diverse K₅ covers to try before giving up. Each
   * cover is a fundamentally different Phase 2 decomposition;
   * iterating through them is what turns a single-shot greedy
   * search into an (approximate) exhaustive search. Default 8.
   */
  maxCoverCandidates?: number;
}

/**
 * Running statistics emitted on every SearchProgress tick and on
 * the final Class1SearchResult. The UI reports these so users can
 * see how much of the search space the algorithm explored before
 * giving up or timing out.
 */
export interface SearchStats {
  /** Distinct K₅ covers the top-level loop has tried. */
  coversTried: number;
  /** Candidate matchings fed to lpClass1Check across all runs. */
  matchingsTried: number;
  /** fuseOneEdge calls executed during Phase 3. */
  fusionsTried: number;
  /** Raw Phase 3 iterations executed so far. */
  nodesExpanded: number;
  /** Smallest LP hinge-loss residual observed at any expansion. */
  bestLpResidual: number;
}

/**
 * Scoreable snapshot of the best "almost a Class-1 tensegrity"
 * state we've seen during the search.
 *
 * Class-k is the maximum number of struts incident to any single
 * node: k = 1 is a true matching (ideal Class-1 tensegrity), k = 2
 * means some node carries two struts, etc. Lower is always better.
 * We prefer structures whose every input node is connected to at
 * least one member, because a disconnected node is an obvious
 * failure mode that the LP can "satisfy" trivially.
 *
 * Ranking priority (from `scoreBestResult`):
 *   1. allConnected  (every node touches ≥ 1 member)
 *   2. classK        (smaller = closer to canonical Class-1)
 *   3. numMembers    (smaller = cleaner graph)
 *   4. lpResidual    (smaller = better self-stress quality)
 *
 * The BestResult is the single "most presentable" snapshot across
 * the entire search: beam-search branches, cover attempts, and
 * individual Phase 3 iterations all call `updateBest` so the
 * final return value of `searchClass1Tensegrity` always reflects
 * the highest-quality state the algorithm ever saw — even if no
 * cover attempt ever produced a true Class-1 success.
 */
interface BestResult {
  state: MorphogenesisState;
  matching: number[];
  classK: number;
  numMembers: number;
  numStruts: number;
  allConnected: boolean;
  lpResidual: number;
  success: boolean;
}

/**
 * Lower score = better; `Infinity` = completely unusable.
 */
function scoreBestResult(r: BestResult): number {
  if (r.success) return Number.NEGATIVE_INFINITY;
  if (!r.allConnected) return Number.POSITIVE_INFINITY;
  return (
    r.classK * 1000 +
    r.numMembers * 1 +
    (Number.isFinite(r.lpResidual) ? r.lpResidual * 0.1 : 1e6)
  );
}

/**
 * Internal "tick & yield" helper passed down into each phase. It
 * bumps the progress counter, lets the UI breathe, and returns true
 * once the search is out of time (or has been aborted).
 *
 * The closure captures `startedAt`, `deadline`, and a mutable `tick`
 * so the driver owns a single source of truth for elapsed time.
 */
type YieldFn = (phase?: string) => Promise<boolean>;

function createYield(
  startedAt: number,
  deadline: number,
  getState: () => MorphogenesisState,
  options: Class1SearchOptions,
): { yield: YieldFn; getTick: () => number; getPhase: () => string } {
  let tick = 0;
  let phase = 'init';
  const yieldToLoop = options.yieldToEventLoop ?? true;

  const yieldFn: YieldFn = async (nextPhase) => {
    if (nextPhase) phase = nextPhase;
    tick++;
    const now = Date.now();
    const elapsedMs = now - startedAt;
    const remainingMs = deadline - now;
    const deadlineReached = remainingMs <= 0;
    options.onProgress?.({
      phase,
      tick,
      elapsedMs,
      remainingMs,
      deadlineReached,
      state: getState(),
    });
    if (yieldToLoop) {
      // Yield until the next browser paint. requestAnimationFrame
      // fires right before a frame is committed, which means: the
      // search synchronously dispatches onProgress → React schedules
      // a re-render → the current microtask ends → rAF fires → the
      // browser paints the new frame → we resume the search. This
      // gives the viewer a natural ~60 Hz animation loop and avoids
      // the "search finishes too fast to see anything" problem that
      // a plain `setTimeout(0)` has when paints are coalesced.
      //
      // In Node (tests) `requestAnimationFrame` is undefined, so we
      // fall back to a macrotask.
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
    return deadlineReached || (options.signal?.aborted ?? false);
  };

  return {
    yield: yieldFn,
    getTick: () => tick,
    getPhase: () => phase,
  };
}

// ─── Phase 0 ───────────────────────────────────────────────

export function generateOrValidatePoints(
  n: number,
  points: Vec3[] | null,
  seed?: number,
): Vec3[] {
  if (n < 5) throw new Error('n must be ≥ 5');
  let rng = mulberry32(seed ?? Date.now());

  let P: Vec3[];
  if (points && points.length >= n) {
    P = points.slice(0, n).map(p => [p[0], p[1], p[2]] as Vec3);
  } else {
    // Uniform samples in [-1, 1]³ — centred so the first cell lands
    // near the origin and the whole structure is visible in the viewer.
    P = Array.from({ length: n }, () => [
      rng() * 2 - 1,
      rng() * 2 - 1,
      rng() * 2 - 1,
    ] as Vec3);
  }

  // General position check: for small n do all C(n,4); for larger n
  // sample 1000 random quadruples. Any degeneracy found is fixed by
  // a tiny perturbation of the last point.
  const maxChecks = 1000;
  const combos = n <= 15
    ? allCombinations4(n)
    : sampleCombinations4(n, maxChecks, rng);
  for (const [i, j, k, l] of combos) {
    if (Math.abs(vol(P[i], P[j], P[k], P[l])) < 1e-9) {
      P[l] = [
        P[l][0] + (rng() - 0.5) * 2e-3,
        P[l][1] + (rng() - 0.5) * 2e-3,
        P[l][2] + (rng() - 0.5) * 2e-3,
      ];
    }
  }
  return P;
}

// ─── Phase 1–2: build structure from the K₅ cover ──────────

/**
 * Result of buildStructureFromCover.
 *
 * The previous version returned a plain `boolean` where `true` meant
 * *both* "normal completion" and "timeout after at least the seed was
 * placed". That conflation hid a serious bug: when Phase 2 timed out
 * after placing only the seed K₅, enforceClass1 would immediately
 * observe the deadline, return with an empty α, and
 * assignForceDensities would fall back to column 0 of W — handing
 * the caller a raw K₅ prism with sign-violated cables.
 *
 * Splitting the outcome into three flags lets the caller distinguish:
 *   - built = false              → no seed cell → hard failure
 *   - built = true, complete = false → partial Phase 2 → skip Phase 3
 *   - built = true, complete = true  → all cover cells adhered → run Phase 3
 */
interface BuildResult {
  built: boolean;
  complete: boolean;
  timedOut: boolean;
}

async function buildStructureFromCover(
  P: Vec3[],
  state: MorphogenesisState,
  yieldFn: YieldFn,
  precomputedCover?: K5CoverEntry[],
): Promise<BuildResult> {
  // The beam-search driver passes one of the
  // `enumerateDiverseCovers` candidates in `precomputedCover`; the
  // legacy path calls `buildK5Cover(P)` (which is now functionally
  // equivalent to `enumerateDiverseCovers(P)[0]`).
  const cover = precomputedCover ?? buildK5Cover(P);
  if (cover.length === 0) {
    return { built: false, complete: false, timedOut: false };
  }

  logEvent(state, {
    kind: 'phase',
    message: `Phase 1 — K₅ cover built (${cover.length} cells)`,
  });
  if (await yieldFn('Phase 1 · K₅ cover')) {
    return { built: false, complete: false, timedOut: true };
  }

  // Seed cell
  const seedIdx = cover[0].newIdx;
  const seedPoints = seedIdx.map(i => P[i]);
  const seedCell = initializeK5(state, seedPoints);
  if (!seedCell) {
    return { built: false, complete: false, timedOut: false };
  }
  // Map source-point index → runtime node_id
  const nodeIdOf = new Map<number, number>();
  seedIdx.forEach((srcIdx, k) => nodeIdOf.set(srcIdx, seedCell.node_ids[k]));
  if (await yieldFn('Phase 2 · seed K₅')) {
    // Seed is up, but the deadline hit before we could adhere any
    // of the rest of the cover.
    return { built: true, complete: false, timedOut: true };
  }

  logEvent(state, {
    kind: 'phase',
    message: 'Phase 2 — Cellular morphogenesis (adhesion loop)',
  });

  for (let step = 1; step < cover.length; step++) {
    // Deadline check at the top of the loop — we'd rather have a
    // partially-built but visible structure than an abrupt timeout
    // mid-adhesion, so we bail cleanly on the boundary.
    if (await yieldFn(`Phase 2 · cell ${step}/${cover.length - 1}`)) {
      return { built: true, complete: false, timedOut: true };
    }
    const { sharedIdx, newIdx } = cover[step];
    const sharedNodeIds: number[] = [];
    let aborted = false;
    for (const s of sharedIdx) {
      const nid = nodeIdOf.get(s);
      if (nid === undefined) { aborted = true; break; }
      sharedNodeIds.push(nid);
    }
    if (aborted) {
      logEvent(state, {
        kind: 'info',
        message: `Skipped cover cell #${step}: shared index not yet attached`,
      });
      continue;
    }
    const newPositions = newIdx.map(i => P[i]);
    // Only support 3- or 4-shared adhesion; if the cover produced 2
    // shared nodes we skip it and rely on the next cell to connect.
    if (sharedNodeIds.length < 3) {
      logEvent(state, {
        kind: 'info',
        message:
          `Skipped cover cell #${step}: only ${sharedNodeIds.length} shared nodes`,
      });
      continue;
    }
    const res = adhereCell(state, sharedNodeIds, newPositions);
    if (!res) {
      logEvent(state, {
        kind: 'info',
        message: `Adhesion failed for cover cell #${step}`,
      });
      continue;
    }
    // Record new runtime ids for the newly introduced source-point indices
    newIdx.forEach((srcIdx, k) => nodeIdOf.set(srcIdx, res.addedNodeIds[k]));
    // Post-adhesion yield: the viewer should paint the new cell
    // before we start the next one. Without this, Phase 2 runs to
    // completion in a single microtask and the user never sees the
    // structure growing step by step.
    if (await yieldFn(`Phase 2 · cell ${step}/${cover.length - 1} adhered`)) {
      return { built: true, complete: false, timedOut: true };
    }
  }

  return { built: true, complete: true, timedOut: false };
}

// ─── Phase 3: Class-1 enforcement ──────────────────────────

/** Flatten SELF_STRESS_ENTRY rows into a dense |E|×k W matrix. */
function denseW(state: MorphogenesisState): { W: number[][]; memberIdx: Map<number, number> } {
  const E = state.members.length;
  const k = state.selfStressStates.length;
  const memberIdx = new Map<number, number>();
  state.members.forEach((m, i) => memberIdx.set(m.member_id, i));

  const W: number[][] = Array.from({ length: E }, () => new Array(k).fill(0));
  const stateIdx = new Map<number, number>();
  state.selfStressStates.forEach((s, j) => stateIdx.set(s.state_id, j));
  for (const entry of state.selfStressEntries) {
    const i = memberIdx.get(entry.member_id);
    const j = stateIdx.get(entry.state_id);
    if (i !== undefined && j !== undefined) W[i][j] = entry.w_value;
  }
  return { W, memberIdx };
}

/**
 * Materialise w* = W·α and copy it into MEMBER.force_density + type.
 *
 * IMPORTANT (C1 correction): the member TYPE is read off the sign of
 * w*, never from the candidate matching. The matching M is only the
 * *target* strut set handed to the LP; the LP's feasibility contract
 * guarantees that, on success, sign(w*_e) agrees with "e ∈ M". If we
 * were to instead set the type from M membership, then every time the
 * LP returned a residual-but-we-still-accepted α (or was misclassified
 * as feasible), we would happily label cables with q < 0 — the exact
 * bug the cable-force-density regression exposed.
 *
 * Members with |w*| < ε at the current α are "zero-force" members:
 * the LP was free to pick either sign for them. We leave them as
 * 'candidate' and log the count so the caller can decide whether to
 * prune them.
 */
function applyAlpha(
  state: MorphogenesisState,
  W: number[][],
  alpha: number[],
  eps: number = 1e-8,
): { numStrut: number; numCable: number; numZero: number } {
  state.alpha = [...alpha];
  let numStrut = 0, numCable = 0, numZero = 0;
  for (let i = 0; i < state.members.length; i++) {
    let v = 0;
    for (let j = 0; j < W[0].length; j++) v += W[i][j] * alpha[j];
    const m = state.members[i];
    m.force_density = v;
    if (v < -eps) { m.type = 'strut'; numStrut++; }
    else if (v > +eps) { m.type = 'cable'; numCable++; }
    else { m.type = 'candidate'; numZero++; }
  }
  return { numStrut, numCable, numZero };
}

/**
 * Conflict detection. A pair (strut, cable) is in conflict iff its 2×k
 * restriction of W has rank < 2 — there is no α that separates the two
 * members in opposite signs. We also skip pairs where either row is
 * numerically zero: such members are force-free in every state and can
 * be freely assigned either type, so they should not be flagged.
 */
function findConflicts(
  W: number[][],
  memberIdx: Map<number, number>,
  matching: number[],
  allEdges: Edge[],
): Array<{ strutId: number; cableId: number }> {
  const strutSet = new Set(matching);
  const out: Array<{ strutId: number; cableId: number }> = [];
  const k = W[0]?.length ?? 0;

  const rowNorm = (row: number[]): number => {
    let s = 0;
    for (let j = 0; j < k; j++) s += row[j] * row[j];
    return s;
  };

  for (const sId of matching) {
    const rs = memberIdx.get(sId);
    if (rs === undefined || rowNorm(W[rs]) < 1e-18) continue;
    for (const e of allEdges) {
      if (strutSet.has(e.id)) continue;
      const rc = memberIdx.get(e.id);
      if (rc === undefined || rowNorm(W[rc]) < 1e-18) continue;
      if (!lpPairCheck(W, rs, rc)) {
        out.push({ strutId: sId, cableId: e.id });
      }
    }
  }
  return out;
}

/**
 * Grow dim W by one by registering a brand-new K₅ cell on five
 * **existing input nodes** — never adds a non-input node to the
 * final structure.
 *
 * Why the earlier implementation was buggy
 * ────────────────────────────────────────
 * The previous version sampled 4 existing nodes, conjured up a 5th
 * position via `suggestNewPositions`, and called
 *   adhereCell(state, chosen4, [newPosition])
 * The newly-added node was placed roughly above the centroid of the
 * chosen face. It had no way of ever being removed (no fusion target
 * visits it), so it persisted in `state.nodes` until Phase 4. For
 * small n (5–8) this meant the final `state.nodes.length` exceeded
 * the caller-requested n by 2–4 nodes on a regular basis, violating
 * the fundamental user contract "the structure has exactly the n
 * points I gave you".
 *
 * The fix
 * ────────
 * 1. Restrict the candidate pool to the nodes that were placed by
 *    the original K₅ cover — tracked via `state.inputNodeIds`.
 * 2. Pick 5 distinct input nodes and register them as a new K₅
 *    cell. We reuse `adhereCell` but with `newPositions = []`,
 *    which the adhesion layer now accepts (sharedIds ∈ {3, 4, 5}).
 *    The result is a new SELF_STRESS_STATE column computed from
 *    the 5 existing coordinates, zero new nodes, and a bump in
 *    dim W — exactly the algorithmic effect we wanted without the
 *    phantom extra nodes.
 * 3. If `state.inputNodeIds` has fewer than 5 entries (e.g. the
 *    caller never went through `buildStructureFromCover`, or the
 *    input structure hasn't been built yet), we bail immediately
 *    rather than fall back to adding new nodes.
 */
function addAdhesionForDim(
  state: MorphogenesisState,
  maxTries: number = 20,
): boolean {
  const inputIds = state.nodes
    .filter(n => state.inputNodeIds.has(n.node_id))
    .map(n => n.node_id);
  if (inputIds.length < 5) return false;

  for (let t = 0; t < maxTries; t++) {
    // Pick 5 distinct input nodes uniformly at random.
    const chosen: number[] = [];
    const pool = [...inputIds];
    for (let k = 0; k < 5 && pool.length > 0; k++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool[idx]);
      pool.splice(idx, 1);
    }
    if (chosen.length < 5) return false;

    // Register the 5 existing nodes as a new K₅ cell. adhereCell's
    // relaxed share-count check (≤ 5) handles the newPositions = []
    // case: no new nodes are added, any K₅ edges that weren't yet
    // members are created, and the cell's self-stress column is
    // appended to W (bumping dim W).
    const res = adhereCell(state, chosen, []);
    if (res) {
      logEvent(state, {
        kind: 'adhesion',
        message:
          `dim-W growth: K₅ registered on existing input nodes ` +
          `[${chosen.join(',')}] (+${res.addedMemberIds.length} members, ` +
          `dim W → ${state.selfStressStates.length})`,
        cell_id: res.cellId,
        member_ids: res.addedMemberIds,
        dim_W_after: state.selfStressStates.length,
      });
      return true;
    }
  }
  return false;
}

// ─── High-order conflict trap detection & escape ────────────
//
// A "high-order conflict trap" is the pathological case where:
//   (a) LP residual is almost zero (≈1e-7): the hinge-loss
//       minimiser sits just outside the feasible polytope, and
//   (b) applyAlpha(lp.alpha) produces FAR more strut-signed
//       members than the matching size: typical observation was
//       "13 struts, max 5/node" on an n = 10 input, and
//   (c) `findConflicts` reports zero pairwise conflicts: every
//       (strut, cable) pair is individually separable even
//       though the full constraint system is not jointly
//       feasible — this is what "high-order" means.
//
// When those three conditions fire together the existing
// conflict loop spins forever: there is no pairwise conflict to
// fuse, and `perturbMatching` can't change W so the next
// iteration produces the exact same readings. The only way out
// is to force a change in W (fuse an overloaded member, reduce
// the matching size, or grow dim W via adhesion).
//
// These helpers diagnose the trap and carry out the escape
// manoeuvre described in the v7 spec:
//   1. force-fuse the "most overloaded" non-matching member
//   2. drop the weakest edge from the current matching
//   3. grow dim W via the input-point-only adhesion helper
// If all three fail the caller returns its bestResult snapshot
// rather than continuing to thrash.

interface TrapEscapeResult {
  strategy: 'force_fuse' | 'reduce_matching' | 'grow_dim' | 'none';
  success: boolean;
  reducedMatching?: number[];
}

/**
 * True when the current LP state looks like a high-order
 * conflict trap: near-zero residual, massive strut overflow,
 * and zero pairwise conflicts. Callers accumulate consecutive
 * true reads before declaring a trap so a single misdiagnosis
 * can't derail the search.
 */
function isHighOrderConflictTrap(
  lp: LPCheckResult,
  matching: number[],
  W: number[][],
  alpha: number[],
  conflictsLen: number,
  strutEps: number = 1e-8,
  residualEps: number = 1e-5,
): boolean {
  if (lp.residual >= residualEps) return false;
  if (conflictsLen !== 0) return false;
  if (W.length === 0 || alpha.length === 0) return false;

  let numActualStruts = 0;
  for (let i = 0; i < W.length; i++) {
    let v = 0;
    for (let j = 0; j < W[0].length; j++) v += W[i][j] * alpha[j];
    if (v < -strutEps) numActualStruts++;
  }
  // "Far more" = strictly more than 2×|M|. The factor 2 gives
  // some slack for healthy LP solutions where sign(Wα) produces
  // a few extra struts that are still compatible with a valid
  // matching — the trap signature requires a much wider margin.
  return numActualStruts > matching.length * 2;
}

/**
 * Find the non-matching member whose Wα is most negative and
 * which sits on the busiest node (the "most overloaded" member).
 * Fusing this member is the strongest single edit to W: it
 * removes the member from the structure entirely, dropping its
 * row from W, and breaking the sign coupling that was trapping
 * the LP.
 */
function findMostOverloadedMember(
  state: MorphogenesisState,
  W: number[][],
  alpha: number[],
  matching: number[],
): number | null {
  if (W.length === 0 || alpha.length === 0) return null;
  const wStar = W.map(row =>
    row.reduce((s, v, j) => s + v * alpha[j], 0),
  );

  const nodeStrutCount = new Map<number, number>();
  for (let i = 0; i < state.members.length; i++) {
    if (wStar[i] < -1e-8) {
      const m = state.members[i];
      nodeStrutCount.set(m.node_a, (nodeStrutCount.get(m.node_a) ?? 0) + 1);
      nodeStrutCount.set(m.node_b, (nodeStrutCount.get(m.node_b) ?? 0) + 1);
    }
  }

  let maxLoad = 0;
  let overloadedNode = -1;
  for (const [nodeId, count] of nodeStrutCount) {
    if (count > maxLoad) { maxLoad = count; overloadedNode = nodeId; }
  }
  if (maxLoad <= 1 || overloadedNode === -1) return null;

  const matchingSet = new Set(matching);
  let bestId: number | null = null;
  let bestW = 0;
  for (let i = 0; i < state.members.length; i++) {
    const m = state.members[i];
    if (matchingSet.has(m.member_id)) continue;
    if (m.node_a !== overloadedNode && m.node_b !== overloadedNode) continue;
    if (wStar[i] < bestW) {
      bestW = wStar[i];
      bestId = m.member_id;
    }
  }
  return bestId;
}

/**
 * Drop the "weakest" member from the matching — the one whose
 * Wα is closest to zero — shrinking the LP's constraint set by
 * one. This gives the LP more slack to satisfy the remaining
 * constraints on the same W.
 */
function reduceMatching(
  matching: number[],
  memberIdx: Map<number, number>,
  W: number[][],
  alpha: number[],
): number[] {
  if (matching.length <= 1) return matching;
  const wStar = W.map(row =>
    row.reduce((s, v, j) => s + v * alpha[j], 0),
  );
  let weakestId = matching[0];
  let weakestAbs = Infinity;
  for (const id of matching) {
    const row = memberIdx.get(id);
    if (row === undefined) continue;
    const abs = Math.abs(wStar[row]);
    if (abs < weakestAbs) { weakestAbs = abs; weakestId = id; }
  }
  return matching.filter(id => id !== weakestId);
}

/**
 * Try the three escape strategies in order. Returns
 * `success = true` on the first strategy that changes the
 * state, along with the strategy name for logging. On
 * `reduce_matching` the caller is expected to replace its
 * working matching with `result.reducedMatching` on the next
 * iteration.
 */
function executeTrapEscape(
  state: MorphogenesisState,
  matching: number[],
  memberIdx: Map<number, number>,
  W: number[][],
  alpha: number[],
  dimW: number,
): TrapEscapeResult {
  // Strategy 1: force-fuse the overloaded member.
  if (dimW > 1) {
    const overloadedId = findMostOverloadedMember(state, W, alpha, matching);
    if (overloadedId !== null) {
      logEvent(state, {
        kind: 'strategic_fusion',
        message:
          `High-order trap escape: force-fusing overloaded member #${overloadedId}`,
        member_ids: [overloadedId],
      });
      fuseOneEdge(state, overloadedId);
      return { strategy: 'force_fuse', success: true };
    }
  }

  // Strategy 2: reduce matching size.
  if (matching.length > 1) {
    const reduced = reduceMatching(matching, memberIdx, W, alpha);
    if (reduced.length < matching.length) {
      logEvent(state, {
        kind: 'info',
        message:
          `High-order trap escape: reducing matching ${matching.length} → ${reduced.length}`,
      });
      return { strategy: 'reduce_matching', success: true, reducedMatching: reduced };
    }
  }

  // Strategy 3: force dim-W growth.
  const grew = addAdhesionForDim(state);
  if (grew) {
    logEvent(state, {
      kind: 'info',
      message: `High-order trap escape: forced dim(W) growth`,
    });
    return { strategy: 'grow_dim', success: true };
  }

  return { strategy: 'none', success: false };
}

async function enforceClass1(
  state: MorphogenesisState,
  yieldFn: YieldFn,
  bestHolder: { value: BestResult | null },
): Promise<{
  success: boolean;
  alpha: number[];
  matching: number[];
  timedOut: boolean;
}> {
  // Hard safety cap on the number of iterations so a runaway LP bug
  // can't spin forever even if the caller's clock is wrong. Users
  // normally terminate the search via the `timeoutMs` option instead;
  // `HARD_ITER_CAP` exists purely as a belt-and-braces guard.
  const HARD_ITER_CAP = 10_000;
  // FIX-A — dim-W growth budget is now computed from the actual
  // target dimension, not a hard-coded 3. The Class-1 LP needs at
  // least |M| + 3 ≈ ⌊n/2⌋ + 3 degrees of freedom in W to admit a
  // feasible α; adding a little slack gives us a target of
  // ⌊n/2⌋ + 4. The budget is the gap between that target and the
  // current dim W, with a floor of 10 so small-n structures
  // (where the initial dim W is already close to target) still
  // get enough tries to break out of a "fuse → 1 → grow → 2"
  // oscillation. Previously the cap was a flat 3, which caused
  // n = 6 to exhaust its budget after 3 iterations and fall
  // through to column-0 force-density assignment, returning a
  // raw K₅ prism with sign-violated cables.
  const targetDimW = Math.floor(state.nodes.length / 2) + 4;
  const MAX_ADHESION_GROWS = Math.max(
    10,
    targetDimW - state.selfStressStates.length,
  );
  const SIGN_EPS = 1e-8;
  logEvent(state, {
    kind: 'phase',
    message:
      `Phase 3 — Class-1 enforcement ` +
      `(dim W target=${targetDimW}, growth budget=${MAX_ADHESION_GROWS})`,
  });
  if (await yieldFn('Phase 3 · enforce Class-1')) {
    return { success: false, alpha: [], matching: [], timedOut: true };
  }

  let perturbSeed = 0;
  let adhesionGrowCount = 0;
  // High-order trap detection: we only declare the loop stuck
  // after it matches the trap signature HIGH_ORDER_TRAP_LIMIT
  // consecutive times. Single-iteration coincidences are
  // expected (e.g. a legitimately near-feasible α with a
  // small strut overflow) and should not trigger the escape
  // manoeuvre.
  const HIGH_ORDER_TRAP_LIMIT = 3;
  let highOrderTrapStreak = 0;
  // When the escape dispatcher chooses `reduce_matching`, the
  // new shrunken matching lands here so the next iteration
  // skips greedyMatching and uses it directly.
  let forcedMatching: number[] | null = null;

  for (let iter = 0; iter < HARD_ITER_CAP; iter++) {
    // Deadline check at the top of every iteration so we always
    // emit current state before we stop.
    if (await yieldFn(`Phase 3 · iter ${iter + 1}`)) {
      logEvent(state, {
        kind: 'info',
        message: `Phase 3 stopped at iteration ${iter + 1} (time budget exhausted)`,
      });
      // Give the caller what we have so they can visualise it.
      assignForceDensities(state);
      state.matching = state.members
        .filter(m => m.type === 'strut').map(m => m.member_id);
      return {
        success: false,
        alpha: state.alpha,
        matching: state.matching,
        timedOut: true,
      };
    }

    const { W, memberIdx } = denseW(state);
    if (W.length === 0 || W[0].length === 0) {
      logEvent(state, {
        kind: 'failure',
        message: 'No self-stress basis left — giving up',
      });
      return { success: false, alpha: [], matching: [], timedOut: false };
    }

    const edges: Edge[] = state.members.map(m => ({
      id: m.member_id, node_a: m.node_a, node_b: m.node_b,
    }));

    // Step D1: choose a candidate strut set = maximum matching on G.
    //
    // Priority = "strutness" = max over self-stresses of -W[e,j],
    // i.e. the most-negative value any self-stress assigns to e.
    // An edge that already carries a strong compressive (negative)
    // force in SOME basis self-stress is a natural strut, and LP
    // feasibility is overwhelmingly driven by whether the matching
    // aligns with the natural sign structure of the basis.
    //
    // Total |W[e,j]| (the original priority) biases toward edges
    // that appear in multiple cells with large magnitude — exactly
    // the diagonals that the Triplex construction wants to fuse
    // out, not keep as struts. On n = 6 the old priority produced
    // the matching {AB, CF, DE} (all cables in Aloui §5), while
    // strutness produces {A-E, C-D, B-F} — the correct Triplex
    // strut set — by picking BF (1.0), AE (0.667), CD (0.5)
    // in that order from a simple greedy.
    const strutness = (e: Edge) => {
      const i = memberIdx.get(e.id);
      if (i === undefined) return 0;
      let mostNegative = 0;
      for (let j = 0; j < W[0].length; j++) {
        if (W[i][j] < mostNegative) mostNegative = W[i][j];
      }
      return -mostNegative;
    };
    // Use the matching handed to us by a previous iteration's
    // trap-escape (strategy = `reduce_matching`) if one is
    // pending; otherwise recompute a fresh strutness-ranked
    // maximum matching. The `forcedMatching` override is one-
    // shot: we clear it after consuming it.
    let matching: number[];
    if (forcedMatching !== null) {
      matching = forcedMatching;
      forcedMatching = null;
    } else {
      matching = greedyMatching(edges, strutness, 12);
    }
    logEvent(state, {
      kind: 'matching',
      message: `Iter ${iter + 1}: matching size ${matching.length} / ⌊n/2⌋=${Math.floor(state.nodes.length / 2)}`,
      matching_ids: [...matching],
    });

    const dimW = state.selfStressStates.length;

    // Step D2: LP feasibility check.
    //
    // We use the ASYNC variant here so the gradient descent
    // yields control to the event loop every ~100 iterations,
    // letting the 3D viewer repaint while the solver runs. On
    // n = 20 a single synchronous LP call used to block the
    // main thread for hundreds of milliseconds — long enough
    // that users saw the viewer "freeze" mid-search. The
    // asynchronous version passes the search's top-level
    // yieldFn through, so the LP obeys the same wall-clock
    // deadline and abort signal as the rest of Phase 3.
    const strutIds = matching;
    const cableIds = edges.filter(e => !matching.includes(e.id)).map(e => e.id);
    const lp = await lpClass1CheckAsync(
      W, memberIdx, strutIds, cableIds,
      async () => yieldFn(),
    );

    logEvent(state, {
      kind: 'lp_check',
      message: `LP ${lp.feasible ? 'feasible' : 'infeasible'} (residual=${lp.residual.toExponential(2)})`,
      dim_W_before: dimW,
      dim_W_after: dimW,
    });

    // Per-iteration best-result update. Captures the CURRENT
    // Phase-3 snapshot (with its newly-computed force densities
    // if applyAlpha would classify them) even if we end up
    // rolling back the types on a matching-failure. We track the
    // lpResidual so structures that are closer to feasibility
    // out-score those stuck at the degenerate α=0 origin.
    {
      const savedTypes = state.members.map(m => m.type);
      const savedFD = state.members.map(m => m.force_density);
      // Try the sign-derived types without committing.
      if (lp.alpha.some(v => Math.abs(v) > 1e-12)) {
        applyAlpha(state, W, lp.alpha, SIGN_EPS);
      }
      bestHolder.value = updateBestFromState(
        bestHolder.value,
        state,
        lp.residual,
        false, // provisional; real success path still sets it below
      );
      // Roll back: the actual success / fall-through logic below
      // re-applies α if it wants to.
      state.members.forEach((m, i) => {
        m.type = savedTypes[i];
        m.force_density = savedFD[i];
      });
    }

    // Sign-pattern verification (C2 correction). Even when the LP
    // reports feasibility we double-check that w* = W·α really does
    // pair up with the intended strut/cable split: the LP's hinge-loss
    // minimiser accepts residuals up to 1e-4, which can allow small
    // sign flips on members whose |w*| is near ε. However, because
    // C1 reassigns types from sign(w*) rather than from M membership,
    // a partial sign-mismatch is only fatal if it breaks Class-1 (two
    // struts sharing a node). So we accept the LP whenever the
    // sign-driven relabelling still yields a valid matching; otherwise
    // we fall through to conflict resolution.
    // Whether or not the LP's hard-feasibility check passed, the
    // important question is: "does applyAlpha(lp.alpha) yield a
    // sign-consistent Class-1 matching?" The hard check has a fixed
    // absolute margin that doesn't play nicely with heavy
    // normalisation, so a solution with residual well below
    // |E|·ε² can still be flagged infeasible even though sign(Wα)
    // gives every member a clean, unique role. So we always try
    // applyAlpha + matching check first and only fall into conflict
    // resolution if the sign-based relabelling fails to produce a
    // valid matching.
    //
    // The only case we skip is the trivial degenerate α = 0 (max|Wα|
    // basically zero); applyAlpha would classify every member as
    // 'candidate' and the empty strut set trivially passes V2 but
    // that is not a tensegrity — validateMatching now rejects it.
    const alphaIsNonTrivial = lp.alpha.some(v => Math.abs(v) > 1e-12);
    if (alphaIsNonTrivial) {
      const savedTypes = state.members.map(m => m.type);
      const savedFD = state.members.map(m => m.force_density);
      const counts = applyAlpha(state, W, lp.alpha, SIGN_EPS);

      const struts = state.members.filter(m => m.type === 'strut');
      const seen = new Set<number>();
      let matchingOK = struts.length > 0;
      for (const s of struts) {
        if (seen.has(s.node_a) || seen.has(s.node_b)) {
          matchingOK = false; break;
        }
        seen.add(s.node_a); seen.add(s.node_b);
      }

      if (matchingOK) {
        const actualStrutIds = struts.map(m => m.member_id);
        state.matching = actualStrutIds;
        logEvent(state, {
          kind: 'success',
          message:
            `Class-1 reached: ${counts.numStrut} struts, ${counts.numCable} cables` +
            (counts.numZero > 0 ? `, ${counts.numZero} zero-force` : '') +
            (lp.feasible ? '' : ` (LP residual=${lp.residual.toExponential(2)})`),
          matching_ids: actualStrutIds,
        });
        // Emit one more tick so the UI paints the final happy state.
        await yieldFn('Phase 3 · reached Class-1');
        return {
          success: true,
          alpha: lp.alpha,
          matching: actualStrutIds,
          timedOut: false,
        };
      }

      // Roll back — the sign-driven relabelling broke Class-1, so
      // we need to retry with another matching or strategic fusion.
      state.members.forEach((m, i) => {
        m.type = savedTypes[i];
        m.force_density = savedFD[i];
      });
      const violatingMaxComp = (() => {
        const perNode = new Map<number, number>();
        let maxN = 0;
        for (const s of struts) {
          const na = (perNode.get(s.node_a) ?? 0) + 1;
          const nb = (perNode.get(s.node_b) ?? 0) + 1;
          perNode.set(s.node_a, na);
          perNode.set(s.node_b, nb);
          if (na > maxN) maxN = na;
          if (nb > maxN) maxN = nb;
        }
        return maxN;
      })();
      logEvent(state, {
        kind: 'info',
        message:
          `sign(Wα) yields ${struts.length} struts, max ${violatingMaxComp}/node ` +
          `(not a valid matching); falling through to conflict resolution`,
      });
    }

    // Kernel-driven fusion. The Triplex case (n = 6) illustrates why
    // this is necessary: after the two-cell adhesion, dim W = 2 and
    // the LP's α for the Triplex matching {A-E, C-D, B-F} happens to
    // zero BOTH diagonal members BD and CE exactly. BD's row and
    // CE's row in W are parallel ((-0.333, +0.500) vs (+0.333,
    // -0.500)), so the unique α giving the Triplex strut signs also
    // lies in their common kernel. Those members can't be cables in
    // THIS structure — they need to be *fused out* so the surviving
    // α becomes the Triplex self-stress. findConflicts only reports
    // pairwise rank collisions and never flags BD/CE against a
    // single strut, so the greedy conflict loop would go in circles.
    //
    // The fix: right after the LP runs, look at Wα on every member
    // that is NOT in the current matching. Any with |Wα| below the
    // ε margin is a "kernel member" — stuck at zero under the LP's
    // preferred direction. Fusing such a member drops dim W by at
    // most one and cannot hurt the LP sign structure, since the
    // member contributed nothing to the constraints anyway. We fuse
    // at most one per iteration so dim W shrinks monotonically.
    //
    // spec-v8 guard — skip kernel fusion on trivial α.
    //
    // When the LP's descent lands on the degenerate α ≈ 0 minimum
    // (residual ≈ |E|·ε²) every member trivially has |Wα| below
    // the 1e-6 threshold, so the naive code above flagged ALL
    // non-matching members as "kernel" and single-stepped through
    // them, monotonically eroding dim W from 8 → 7 → ... → 1
    // without ever making real progress toward feasibility. The
    // guard computes max|Wα| over the full member set and skips
    // the kernel detection entirely when it's below a threshold
    // 1000× larger than ε — any real self-stress direction has at
    // least one member whose Wα is far above the noise floor, so
    // the threshold catches trivial α while leaving real kernel
    // detection (like the Triplex BD/CE case) untouched.
    const matchingSetLocal = new Set(matching);
    const kernelMembers: number[] = [];
    const TRIVIAL_ALPHA_THRESHOLD = 1e-3;
    let maxAbsWalpha = 0;
    {
      const alpha = lp.alpha;
      for (let i = 0; i < state.members.length; i++) {
        let wa = 0;
        for (let j = 0; j < W[0].length; j++) wa += W[i][j] * alpha[j];
        if (Math.abs(wa) > maxAbsWalpha) maxAbsWalpha = Math.abs(wa);
      }
      const alphaIsTrivial = maxAbsWalpha < TRIVIAL_ALPHA_THRESHOLD;
      if (alphaIsTrivial) {
        logEvent(state, {
          kind: 'info',
          message:
            `Kernel-fusion skipped: α is trivial ` +
            `(max|Wα|=${maxAbsWalpha.toExponential(2)} ` +
            `< threshold ${TRIVIAL_ALPHA_THRESHOLD})`,
        });
      } else {
        for (let i = 0; i < state.members.length; i++) {
          const m = state.members[i];
          if (matchingSetLocal.has(m.member_id)) continue;
          // Raw Wα (not normalised — we want to detect true kernel).
          let wa = 0;
          for (let j = 0; j < W[0].length; j++) wa += W[i][j] * alpha[j];
          // Also skip members whose row is already all-zero (the LP's
          // zero-row filter handles those separately).
          let rowNorm = 0;
          for (let j = 0; j < W[0].length; j++) rowNorm += W[i][j] * W[i][j];
          if (rowNorm < 1e-18) continue;
          if (Math.abs(wa) < 1e-6) kernelMembers.push(m.member_id);
        }
      }
    }
    const alphaIsTrivial = maxAbsWalpha < TRIVIAL_ALPHA_THRESHOLD;

    if (kernelMembers.length > 0 && dimW > 1) {
      const kid = kernelMembers[0];
      logEvent(state, {
        kind: 'strategic_fusion',
        message:
          `Kernel-fusion: member #${kid} has Wα ≈ 0 ` +
          `(${kernelMembers.length} such member(s)); fusing to remove from the problem`,
        member_ids: [kid],
        dim_W_before: dimW,
      });
      fuseOneEdge(state, kid);
      continue;
    }

    // Step D3: find conflicts
    const conflicts = findConflicts(W, memberIdx, matching, edges);
    logEvent(state, {
      kind: 'conflict',
      message: `Identified ${conflicts.length} LP conflicts`,
      conflict_count: conflicts.length,
    });

    if (conflicts.length === 0) {
      // High-order conflict trap detection (spec v7).
      //
      // Three consecutive iterations where LP residual is
      // near-zero, sign(Wα) produces far more struts than
      // |M|, AND findConflicts reports zero pairwise
      // conflicts mean we're stuck in a fixed point that
      // perturbMatching cannot escape (it doesn't change W).
      // The escape dispatcher tries force-fusing, matching
      // reduction, and dim-W growth in order; one of them
      // must succeed or we give up and return the best
      // snapshot we've seen so far.
      if (isHighOrderConflictTrap(lp, matching, W, lp.alpha, conflicts.length)) {
        highOrderTrapStreak++;
        logEvent(state, {
          kind: 'info',
          message:
            `High-order conflict trap detected ` +
            `(streak ${highOrderTrapStreak}/${HIGH_ORDER_TRAP_LIMIT}, ` +
            `residual=${lp.residual.toExponential(2)})`,
        });
        if (highOrderTrapStreak >= HIGH_ORDER_TRAP_LIMIT) {
          highOrderTrapStreak = 0;
          const escape = executeTrapEscape(
            state, matching, memberIdx, W, lp.alpha, dimW,
          );
          if (!escape.success) {
            logEvent(state, {
              kind: 'failure',
              message: 'High-order trap: all escape strategies exhausted',
            });
            assignForceDensities(state);
            state.matching = state.members
              .filter(m => m.type === 'strut').map(m => m.member_id);
            return {
              success: false,
              alpha: lp.alpha,
              matching: state.matching,
              timedOut: false,
            };
          }
          if (escape.strategy === 'reduce_matching' && escape.reducedMatching) {
            forcedMatching = escape.reducedMatching;
          }
          continue;
        }
      } else {
        highOrderTrapStreak = 0;
      }

      // spec-v8 — trivial-α escape. If the LP is parked at the
      // α≈0 minimum (residual ≈ |E|·ε²) AND there are no
      // pairwise conflicts, growing dim W by adhesion doesn't
      // help — a bigger W wouldn't change the fact that the
      // hinge-loss descent is stuck at the trivial origin.
      // Perturbing the matching at least forces the LP to
      // redraw its target half-spaces and gives it a new
      // starting-basin hint, which is the only thing that can
      // actually push descent out of the degenerate minimum.
      if (alphaIsTrivial) {
        logEvent(state, {
          kind: 'info',
          message:
            'Trivial α with 0 conflicts: perturbing matching to escape LP dead-zone',
        });
        const altTrivial = perturbMatching(edges, matching, ++perturbSeed);
        if (altTrivial.join(',') !== matching.join(',')) {
          forcedMatching = altTrivial;
          continue;
        }
        // Perturbation exhausted on the trivial-α path — fall
        // through to the generic adhesion/perturbation branch
        // below so the usual termination logic kicks in.
      }

      // No PAIRWISE conflict — each individual (strut, cable) pair
      // is linearly independent in W, so no fusion target is
      // diagnosable. But LP infeasibility with 0 conflicts means
      // the constraints are JOINTLY infeasible, typically because
      // W has too few columns (dim W too small) to separate all
      // |E| constraints into their demanded half-spaces. Growing
      // dim W by adhesion is the natural move here — fusion would
      // only make things worse.
      //
      // Fall back to ALTERNATIVE_MATCHING only if we've exhausted
      // the adhesion budget.
      if (adhesionGrowCount < MAX_ADHESION_GROWS) {
        logEvent(state, {
          kind: 'info',
          message:
            `No pairwise conflicts but LP infeasible → ` +
            `growing dim W by adhesion (${adhesionGrowCount + 1}/${MAX_ADHESION_GROWS})`,
        });
        const grew = addAdhesionForDim(state);
        if (grew) { adhesionGrowCount++; continue; }
      }
      logEvent(state, {
        kind: 'info',
        message: 'No direct conflicts; perturbing matching',
      });
      const alt = perturbMatching(edges, matching, ++perturbSeed);
      if (alt.join(',') === matching.join(',')) {
        // Perturbation exhausted. Honestly assign force densities from
        // the nullspace and return.
        assignForceDensities(state);
        state.matching = state.members
          .filter(m => m.type === 'strut').map(m => m.member_id);
        return {
          success: false,
          alpha: lp.alpha,
          matching: state.matching,
          timedOut: false,
        };
      }
      continue;
    }

    // Step D4: strategic fusion. We zero out the highest-priority
    // blocking member from W using fuseSelfStress — this drops dim W
    // by 1 and severs the offending sign coupling. When fusion is
    // unavailable (dim W ≤ 1), try growing dim W via adhesion — but
    // bound the number of growths so we terminate cleanly.
    if (dimW <= 1) {
      if (adhesionGrowCount < MAX_ADHESION_GROWS) {
        logEvent(state, {
          kind: 'info',
          message:
            `dim W ≤ 1: cannot fuse; growing basis by adhesion ` +
            `(${adhesionGrowCount + 1}/${MAX_ADHESION_GROWS})`,
        });
        const grew = addAdhesionForDim(state);
        if (grew) { adhesionGrowCount++; continue; }
      }
      logEvent(state, {
        kind: 'failure',
        message: 'Cannot fuse further and adhesion budget exhausted',
      });
      assignForceDensities(state);
      state.matching = state.members
        .filter(m => m.type === 'strut').map(m => m.member_id);
      return {
        success: false,
        alpha: lp.alpha,
        matching: state.matching,
        timedOut: false,
      };
    }
    // FIX-C — protect strut candidates in the current matching.
    //
    // findConflicts reports pairs as (strutId, cableId) based on the
    // matching we handed it above. But the matching is recomputed at
    // the top of every iteration, and an edge that was a "cable" in
    // iteration k can easily become a "strut" in iteration k + 1
    // (greedy maximum-matching on a reshaped W produces different
    // sets). If we blindly fuse the first conflict, we might delete
    // a member that the NEW matching has already promoted to a
    // strut candidate, which shrinks the matching instead of
    // breaking a sign couple — the exact opposite of what strategic
    // fusion should do.
    //
    // Prefer a conflict whose cable side is not currently a strut
    // candidate. If every conflict's cable is already in the
    // matching, we skip fusion for this iteration and let the next
    // loop re-compute the matching on a different W (via adhesion
    // or perturbation).
    const matchingSet = new Set(matching);
    const safePick = conflicts.find(c => !matchingSet.has(c.cableId));
    if (!safePick) {
      logEvent(state, {
        kind: 'info',
        message:
          'All LP conflicts target current strut candidates; ' +
          'skipping fusion this iteration',
      });
      // Try perturbing the matching instead — maybe a different
      // strut set will expose a cable-only conflict next time.
      const alt = perturbMatching(edges, matching, ++perturbSeed);
      if (alt.join(',') === matching.join(',')) {
        // Nothing else to try. Settle on what we have.
        assignForceDensities(state);
        state.matching = state.members
          .filter(m => m.type === 'strut').map(m => m.member_id);
        return {
          success: false,
          alpha: lp.alpha,
          matching: state.matching,
          timedOut: false,
        };
      }
      continue;
    }

    logEvent(state, {
      kind: 'strategic_fusion',
      message:
        `Strategic fusion: dropping cable member #${safePick.cableId} ` +
        `(blocking strut #${safePick.strutId}), dim W ${dimW} → …`,
      member_ids: [safePick.strutId, safePick.cableId],
      dim_W_before: dimW,
    });
    fuseOneEdge(state, safePick.cableId);
  }

  // HARD_ITER_CAP reached — shouldn't happen in practice because the
  // wall-clock deadline is the normal termination path.
  logEvent(state, {
    kind: 'failure',
    message: `Safety iteration cap reached (${HARD_ITER_CAP})`,
  });
  assignForceDensities(state);
  state.matching = state.members
    .filter(m => m.type === 'strut').map(m => m.member_id);
  return {
    success: false,
    alpha: state.alpha,
    matching: state.matching,
    timedOut: false,
  };
}

// ─── Phase 4: validation ───────────────────────────────────

/**
 * V3 — infinitesimal rigidity + prestress stability support.
 *
 * Generically, a rigid pin-jointed structure in 3D satisfies
 *     rank(A) = 3|V| − 6
 * (every mechanism is a rigid-body motion). But non-generic cases
 * like the 6-node Triplex have Maxwell excess B = 0 with dim W = 1
 * and one true internal mechanism, giving rank(A) = 11 instead of
 * 12 for |V| = 6. The old "rank ≥ 3n − 6" test flunked those
 * structures even though they are perfectly valid prestress-
 * stabilised tensegrities.
 *
 * FIX-F returns a structured diagnosis so the caller can accept a
 * structure when EITHER:
 *   - it is infinitesimally rigid (no mechanism at all), OR
 *   - it carries a non-trivial self-stress basis and the number of
 *     mechanisms does not exceed dim W (a necessary — though not
 *     sufficient — condition for prestress stability; V4 then
 *     confirms the sufficient condition via Ω eigenvalues).
 */
interface RigidityResult {
  infinitesimallyRigid: boolean;
  prestressStable: boolean;
  rank: number;
  dimMechanism: number;
  dimW: number;
}

function validateRigidity(state: MorphogenesisState): RigidityResult {
  if (state.nodes.length === 0) {
    return {
      infinitesimallyRigid: false,
      prestressStable: false,
      rank: 0,
      dimMechanism: 0,
      dimW: 0,
    };
  }
  const { A } = buildEquilibriumMatrix(state.nodes, state.members);
  const ker = nullspace(A);
  const rank = state.members.length - ker.length;
  const expectedGenericRank = 3 * state.nodes.length - 6;
  const dimW = state.selfStressStates.length;
  // Number of internal mechanisms = generic-rank shortfall.
  const dimMechanism = Math.max(0, expectedGenericRank - rank);
  const infinitesimallyRigid = dimMechanism === 0;
  // A self-stress can stabilise at most dim W mechanisms. V4
  // confirms the sufficient sign condition via eigenvalues of Ω;
  // here we only rule out the obviously-hopeless cases.
  const prestressStable = dimW > 0 && dimMechanism <= dimW;
  return {
    infinitesimallyRigid,
    prestressStable,
    rank,
    dimMechanism,
    dimW,
  };
}

/**
 * V2 — Class-1 matching condition.
 *
 * A Class-1 tensegrity requires that every node is incident to **at
 * most one strut**. A structure with *zero* struts would trivially
 * satisfy the "at most one" graph rule, but it is not a tensegrity
 * at all — there are no compression elements holding the cable net
 * apart — so we also require that at least one strut exists. Without
 * this extra guard, the validator would report `class1 = true` on
 * runs where the LP failed and `assignForceDensities` left every
 * member with q ≈ 0 / type 'candidate' (#seed 101, n = 10).
 */
function validateMatching(state: MorphogenesisState): boolean {
  const struts = state.members.filter(m => m.type === 'strut');
  if (struts.length === 0) return false;
  const seen = new Set<number>();
  for (const s of struts) {
    if (seen.has(s.node_a) || seen.has(s.node_b)) return false;
    seen.add(s.node_a); seen.add(s.node_b);
  }
  return true;
}

/**
 * V1 — Force density sign consistency.
 *
 * The contract every Class-1 tensegrity must satisfy:
 *     type(e) = cable ⇒ q_e > +ε
 *     type(e) = strut ⇒ q_e < -ε
 * Violations are listed verbatim so the caller can surface them in
 * the search trace.
 */
function validateSignConsistency(
  state: MorphogenesisState,
  eps: number = 1e-8,
): { ok: boolean; violations: Array<{ id: number; type: string; q: number }> } {
  const violations: Array<{ id: number; type: string; q: number }> = [];
  for (const m of state.members) {
    const q = m.force_density ?? 0;
    if (m.type === 'cable' && q < +eps) {
      violations.push({ id: m.member_id, type: 'cable', q });
    } else if (m.type === 'strut' && q > -eps) {
      violations.push({ id: m.member_id, type: 'strut', q });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * V4 — Prestress stability (Connelly & Whiteley, 1996).
 *
 * Build the Connelly stress matrix Ω ∈ ℝ^{n×n}:
 *     Ω_ij = -q_e              if members e = (i, j) exists
 *     Ω_ii =  Σ_{j ~ i} q_{ij} (row-sum condition for equilibrium)
 *     Ω_ij =  0                otherwise
 *
 * The 3D stress matrix is K_geo = Ω ⊗ I₃. Prestress stability holds
 * iff K_geo is positive-semidefinite with a 3·4 = 12-dimensional zero
 * eigenspace coming from affine motions. Since K_geo = Ω ⊗ I₃, every
 * eigenvalue of Ω appears with multiplicity 3, so we only need to
 * eigen-decompose the compact n×n matrix Ω.
 *
 * The test here is weaker but cheap: we assert that the minimum
 * eigenvalue of Ω is ≥ -ε, and log the spectrum for inspection. For
 * infinitesimally rigid structures (which we already verify in V3)
 * this is necessary and sufficient for prestress stability.
 */
function validatePrestressStability(
  state: MorphogenesisState,
  eps: number = 1e-6,
): { ok: boolean; minEig: number } {
  const n = state.nodes.length;
  if (n === 0) return { ok: true, minEig: 0 };
  const idx = new Map<number, number>();
  state.nodes.forEach((nd, i) => idx.set(nd.node_id, i));

  const Omega: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const m of state.members) {
    const i = idx.get(m.node_a);
    const j = idx.get(m.node_b);
    if (i === undefined || j === undefined) continue;
    const q = m.force_density ?? 0;
    Omega[i][j] -= q;
    Omega[j][i] -= q;
    Omega[i][i] += q;
    Omega[j][j] += q;
  }

  const eigs = symmetricEigenvalues(Omega);
  const minEig = eigs.length > 0 ? eigs[0] : 0;
  return { ok: minEig > -eps, minEig };
}

// ─── Entry point ───────────────────────────────────────────

export interface Class1SearchResult {
  state: MorphogenesisState;
  success: boolean;
  rigid: boolean;
  class1: boolean;
  numPoints: number;
  /**
   * Class number of the returned structure:
   *   1 = canonical Class-1 tensegrity (every node ≤ 1 strut)
   *   k = some node carries k struts; lower is always better
   *   0 = structure has no struts at all (the empty-matching
   *       failure case — not a tensegrity)
   */
  bestClassK: number;
  /**
   * True iff every input node is incident to at least one member
   * in the returned structure. A run that leaves a node isolated
   * is considered unusable regardless of how good Class-k looks.
   */
  allConnected: boolean;
  /** True if the search was stopped by the wall-clock deadline. */
  timedOut: boolean;
  /** Wall-clock elapsed time (ms). */
  elapsedMs: number;
  /** Cumulative exploration counters across the whole top-level run. */
  searchStats: SearchStats;
  /**
   * Short human-readable summary of the returned structure. When
   * the search times out without a true Class-1 solution, this
   * explains *why* the best-so-far state was selected (e.g.
   * "best: Class-2, 28 members, 3 struts, LP residual=1.2e-02").
   */
  bestResultNote: string;
}

/**
 * Top-level entry point. Mirrors the ALGORITHM block of the spec.
 * Does not throw on failure; instead populates `state.events` with
 * a trail that the UI can display.
 *
 * The search is *async* and budget-controlled:
 *   - `options.timeoutMs` sets the wall-clock deadline (default 10 s).
 *   - `options.onProgress` is invoked after every significant mutation
 *     so a caller (e.g. the React UI) can redraw live.
 *   - `options.signal` lets the caller cancel mid-run; the current
 *     iteration completes and the function returns a partial result.
 *
 * On every exit path the returned `state` reflects the latest
 * intermediate state — there is no "rollback to empty" on timeout.
 */
export async function searchClass1Tensegrity(
  n: number,
  points: Vec3[] | null = null,
  seed?: number,
  options: Class1SearchOptions = {},
): Promise<Class1SearchResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const maxCoverCandidates = options.maxCoverCandidates ?? 8;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  // Accumulated exploration stats — shared across all cover
  // attempts so the caller sees the full search cost.
  const stats: SearchStats = {
    coversTried: 0,
    matchingsTried: 0,
    fusionsTried: 0,
    nodesExpanded: 0,
    bestLpResidual: Number.POSITIVE_INFINITY,
  };

  // `currentState` is the live state object the yield closure
  // exposes to `onProgress`. We replace it at the start of every
  // cover attempt, so the 3D viewer automatically re-renders the
  // new Phase 2 build each time without the driver needing to
  // know about the outer cover loop.
  let currentState = createEmptyState();
  const driver = createYield(
    startedAt,
    deadline,
    () => currentState,
    options,
  );
  const yieldFn = driver.yield;

  // Phase 0: generate / validate points. Done once for the whole
  // search — subsequent cover attempts reuse the same P array so
  // `state.nodes` always maps to the same caller-provided points.
  logEvent(currentState, {
    kind: 'phase',
    message:
      `Phase 0 — preparing ${n} points (timeout ${timeoutMs} ms, ` +
      `max cover candidates ${maxCoverCandidates})`,
  });
  await yieldFn('Phase 0 · preparing points');
  const P = generateOrValidatePoints(n, points, seed);

  // Enumerate diverse covers once so all attempts share the same
  // candidate list. Each cover is a different Phase 2 base
  // structure; trying several is what turns the old single-shot
  // greedy into an (approximate) exhaustive search.
  const covers = enumerateDiverseCovers(P, maxCoverCandidates);
  logEvent(currentState, {
    kind: 'phase',
    message: `Phase 1 — enumerated ${covers.length} diverse K₅ cover candidate(s)`,
  });

  // Shared best-result holder: threaded into `runCoverAttempt`
  // and further down into `enforceClass1` so EVERY Phase 3
  // iteration across EVERY cover attempt can contribute a
  // candidate snapshot. The final return value is selected from
  // this holder, not from the last cover's terminal state.
  const bestHolder: { value: BestResult | null } = { value: null };
  let lastResult: Class1SearchResult | null = null;
  let lastTimedOut = false;

  for (let ci = 0; ci < covers.length; ci++) {
    // Bail out of the cover loop on timeout before spending CPU
    // on yet another full Phase 2 build.
    if (Date.now() >= deadline) {
      lastTimedOut = true;
      break;
    }

    stats.coversTried++;

    // Fresh state for this attempt. The yield driver will pick
    // this up automatically on the next tick because it reads
    // via the `() => currentState` getter.
    currentState = createEmptyState();
    logEvent(currentState, {
      kind: 'phase',
      message:
        `Cover attempt ${ci + 1}/${covers.length} — ${covers[ci].length} cells`,
    });
    await yieldFn(`Cover ${ci + 1}/${covers.length}`);

    const attempt = await runCoverAttempt(
      P, currentState, covers[ci], yieldFn, n, startedAt, stats, bestHolder,
    );
    lastResult = attempt;
    lastTimedOut = attempt.timedOut;

    // Also update best from the terminal state (in case the
    // enforceClass1 iteration-level tracking missed something).
    bestHolder.value = updateBest(bestHolder.value, attempt);

    if (attempt.success) {
      // Clean win: return immediately so the UI paints the
      // successful structure without the tail-end of the cover
      // loop mutating anything else.
      return {
        ...attempt,
        bestClassK: 1,
        allConnected: true,
        searchStats: stats,
        bestResultNote: describeBest(bestHolder.value ?? updateBest(null, attempt)),
      };
    }
    if (attempt.timedOut) break;
  }

  // Loop exited without a clean success. Return the best snapshot
  // annotated with the cumulative stats. If no cover produced any
  // result at all (e.g. every build failed) we fall back to the
  // last attempt state.
  const best = bestHolder.value;
  const finalResult: Class1SearchResult = best
    ? {
        state: best.state,
        success: best.success,
        rigid: false,
        class1: best.classK <= 1 && best.numStruts > 0,
        numPoints: n,
        bestClassK: Number.isFinite(best.classK) ? best.classK : 0,
        allConnected: best.allConnected,
        timedOut: lastTimedOut,
        elapsedMs: Date.now() - startedAt,
        searchStats: stats,
        bestResultNote: describeBest(best),
      }
    : lastResult
      ? {
          ...lastResult,
          bestClassK: 0,
          allConnected: false,
          searchStats: stats,
          bestResultNote: 'no best snapshot recorded',
        }
      : {
          state: currentState,
          success: false,
          rigid: false,
          class1: false,
          numPoints: n,
          bestClassK: 0,
          allConnected: false,
          timedOut: lastTimedOut,
          elapsedMs: Date.now() - startedAt,
          searchStats: stats,
          bestResultNote: 'no cover attempt completed',
        };
  // Re-run Phase 4 validation on the best snapshot so its rigid
  // flag reflects the actual structure.
  if (best) {
    const rigidResult = validateRigidity(best.state);
    finalResult.rigid =
      rigidResult.infinitesimallyRigid || rigidResult.prestressStable;
  }
  return finalResult;
}

/**
 * Run a single cover attempt: build Phase 2 from the given cover,
 * run enforceClass1, validate, and return a full Class1SearchResult
 * for this attempt. Shared stats (`coversTried`, `matchingsTried`
 * etc.) are accumulated in place on the `stats` argument.
 *
 * `state` MUST be an empty MorphogenesisState owned by this
 * attempt — it is mutated throughout.
 */
async function runCoverAttempt(
  P: Vec3[],
  state: MorphogenesisState,
  cover: K5CoverEntry[],
  yieldFn: YieldFn,
  n: number,
  startedAt: number,
  stats: SearchStats,
  bestHolder: { value: BestResult | null },
): Promise<Class1SearchResult> {
  const buildResult = await buildStructureFromCover(P, state, yieldFn, cover);

  // Freeze the input-node set before Phase 3 so `addAdhesionForDim`
  // never picks non-input nodes.
  state.inputNodeIds = new Set(state.nodes.map(nn => nn.node_id));

  if (!buildResult.built) {
    logEvent(state, {
      kind: 'failure',
      message: 'Structure build failed (no seed cell)',
    });
    await yieldFn('aborted · build failed');
    return {
      state,
      success: false,
      rigid: false,
      class1: false,
      numPoints: n,
      bestClassK: 0,
      allConnected: false,
      timedOut: buildResult.timedOut,
      elapsedMs: Date.now() - startedAt,
      searchStats: stats,
      bestResultNote: 'build failed',
    };
  }

  if (!buildResult.complete) {
    logEvent(state, {
      kind: 'info',
      message:
        `Phase 2 timed out after ${state.cells.length} cell(s); ` +
        `skipping Phase 3`,
    });
    assignForceDensities(state);
    logEvent(state, { kind: 'phase', message: 'Phase 4 — validation (partial build)' });
    await yieldFn('Phase 4 · validation');
    const rigidResult = validateRigidity(state);
    const rigid = rigidResult.infinitesimallyRigid || rigidResult.prestressStable;
    const signCheck = validateSignConsistency(state);
    const class1 = validateMatching(state);
    await yieldFn('done · timeout');
    return {
      state,
      success: false,
      rigid,
      class1,
      numPoints: n,
      bestClassK: 0,
      allConnected: false,
      timedOut: true,
      elapsedMs: Date.now() - startedAt,
      searchStats: stats,
      bestResultNote: 'phase 2 timed out',
    };
  }

  const enforced = await enforceClass1(state, yieldFn, bestHolder);
  stats.nodesExpanded++;
  const lpResidual =
    typeof enforced.alpha !== 'undefined' && enforced.alpha.length > 0
      ? 0
      : Infinity;
  if (lpResidual < stats.bestLpResidual) stats.bestLpResidual = lpResidual;

  if (!enforced.success) assignForceDensities(state);

  logEvent(state, { kind: 'phase', message: 'Phase 4 — validation' });
  await yieldFn('Phase 4 · validation');

  const rigidResult = validateRigidity(state);
  const rigid = rigidResult.infinitesimallyRigid || rigidResult.prestressStable;
  logEvent(state, {
    kind: rigid ? 'info' : 'failure',
    message:
      `V3 rigidity: rank=${rigidResult.rank} / ${3 * state.nodes.length - 6}, ` +
      `mechanisms=${rigidResult.dimMechanism}, dim W=${rigidResult.dimW}, ` +
      `infRigid=${rigidResult.infinitesimallyRigid}, ` +
      `prestressStable=${rigidResult.prestressStable}`,
  });
  const signCheck = validateSignConsistency(state);
  if (!signCheck.ok) {
    logEvent(state, {
      kind: 'failure',
      message:
        `V1 sign consistency FAILED on ${signCheck.violations.length} members: ` +
        signCheck.violations.slice(0, 5)
          .map(v => `#${v.id}(${v.type}, q=${v.q.toExponential(2)})`)
          .join(', '),
      member_ids: signCheck.violations.map(v => v.id),
    });
  }
  const class1 = validateMatching(state);
  const prestress = validatePrestressStability(state);
  logEvent(state, {
    kind: prestress.ok ? 'info' : 'failure',
    message:
      `V4 prestress stability: min eig(Ω) = ${prestress.minEig.toExponential(2)} ` +
      `(${prestress.ok ? 'OK' : 'FAIL'})`,
  });

  const elapsedMs = Date.now() - startedAt;
  const allOK = rigid && class1 && signCheck.ok && enforced.success;
  logEvent(state, {
    kind: allOK ? 'success' : 'info',
    message:
      `Validation: rigid=${rigid}, class1=${class1}, ` +
      `signs=${signCheck.ok}, prestress=${prestress.ok}, lp=${enforced.success}` +
      (enforced.timedOut ? ' (timed out)' : ''),
  });
  await yieldFn(enforced.timedOut ? 'done · timeout' : 'done');

  // Class-k of the attempt's terminal state
  const strutCount = new Map<number, number>();
  for (const m of state.members.filter(m => m.type === 'strut')) {
    strutCount.set(m.node_a, (strutCount.get(m.node_a) ?? 0) + 1);
    strutCount.set(m.node_b, (strutCount.get(m.node_b) ?? 0) + 1);
  }
  let classK = 0;
  for (const c of strutCount.values()) if (c > classK) classK = c;
  const connected = new Set<number>();
  for (const m of state.members) {
    connected.add(m.node_a);
    connected.add(m.node_b);
  }
  const allConnected = state.nodes.every(nd => connected.has(nd.node_id));

  return {
    state,
    success: enforced.success && signCheck.ok && class1,
    rigid,
    class1,
    numPoints: n,
    bestClassK: classK,
    allConnected,
    timedOut: enforced.timedOut,
    elapsedMs,
    searchStats: stats,
    bestResultNote: allOK ? 'Class-1 tensegrity found' : 'attempt did not yield Class-1',
  };
}

/**
 * Score and update the best-so-far snapshot from a Class1SearchResult.
 *
 * Lower score = better. Perfect success pins the score at
 * -Infinity so nothing else can ever displace it. Otherwise we
 * penalise:
 *   - lack of LP success                (large penalty)
 *   - deviation from |M| = ⌊n/2⌋         (moderate penalty)
 *   - negative V4 min-eigenvalue         (small penalty)
 *
 * A deep-clone of `attempt.state` is stored so the outer cover
 * loop can continue mutating its working state without corrupting
 * what we hand back to the caller.
 */
/**
 * Snapshot the current state as a BestResult candidate and return
 * whichever of the incoming/current pair scores lower. Called from
 *  - every Phase 3 iteration inside `enforceClass1`
 *  - every cover attempt in `searchClass1Tensegrity`
 * so the returned `best` always reflects the highest-quality state
 * the algorithm has *ever* produced, not just the last one to
 * terminate. Cloning is deep so later mutations of `state` cannot
 * corrupt the stored snapshot.
 */
function updateBestFromState(
  current: BestResult | null,
  state: MorphogenesisState,
  lpResidual: number,
  success: boolean,
): BestResult {
  const nMembers = state.members.length;

  // Connected-node check.
  const connected = new Set<number>();
  for (const m of state.members) {
    connected.add(m.node_a);
    connected.add(m.node_b);
  }
  const allConnected = state.nodes.every(n => connected.has(n.node_id));

  // Class-k = max struts per node.
  const strutCount = new Map<number, number>();
  const struts = state.members.filter(m => m.type === 'strut');
  for (const m of struts) {
    strutCount.set(m.node_a, (strutCount.get(m.node_a) ?? 0) + 1);
    strutCount.set(m.node_b, (strutCount.get(m.node_b) ?? 0) + 1);
  }
  let classK = 0;
  for (const c of strutCount.values()) if (c > classK) classK = c;
  // If there are no struts at all, classK is 0. A no-strut structure
  // is technically "Class-0" but it is not a tensegrity, so we treat
  // it as having infinite classK for scoring purposes so it never
  // wins over a real structure.
  const effectiveClassK = struts.length > 0 ? classK : Number.POSITIVE_INFINITY;

  const candidate: BestResult = {
    state: deepCloneState(state),
    matching: [...state.matching],
    classK: effectiveClassK,
    numMembers: nMembers,
    numStruts: struts.length,
    allConnected,
    lpResidual,
    success,
  };

  if (current === null) return candidate;
  return scoreBestResult(candidate) < scoreBestResult(current)
    ? candidate
    : current;
}

/** Shim: cover-level updateBest that wraps a Class1SearchResult. */
function updateBest(
  current: BestResult | null,
  attempt: Class1SearchResult,
): BestResult {
  return updateBestFromState(
    current,
    attempt.state,
    attempt.success ? 0 : Number.POSITIVE_INFINITY,
    attempt.success,
  );
}

function describeBest(best: BestResult): string {
  if (best.success) {
    return `Class-1 tensegrity found (${best.numStruts} struts)`;
  }
  const parts: string[] = [];
  if (!best.allConnected) parts.push('unconnected nodes');
  if (Number.isFinite(best.classK)) {
    parts.push(`Class-${best.classK}`);
  } else {
    parts.push('no struts');
  }
  parts.push(`${best.numMembers} members`);
  parts.push(`${best.numStruts} struts`);
  if (Number.isFinite(best.lpResidual)) {
    parts.push(`LP residual=${best.lpResidual.toExponential(2)}`);
  }
  return `best: ${parts.join(', ')}`;
}

// ─── Triplex manual construction demo ───────────────────────
//
// The algorithmic search (`searchClass1Tensegrity`) drives a
// greedy maximum-matching + LP feasibility + strategic-fusion loop
// that cannot reliably discover the specific fusion sequence that
// turns two K₅ cells sharing four nodes into a Triplex
// (seed K₅ {A,B,C,D,E} → adhere K₅ {B,C,D,E,F} → fuse BD → fuse CE).
// That sequence is a hand-crafted construction from Aloui et al.
// §5, not something the greedy enforcement phase is guaranteed to
// find.
//
// `buildTriplexManually` replays the hand-crafted sequence directly
// on the same async + yield + event machinery as the main search
// entry point, so the UI sees live ticks for seed placement, the
// adhesion, each fusion, and Phase 4 validation. Requires exactly
// 6 points in the canonical Triplex layout (two triangles with a
// 30° twist); the caller is expected to have provided them via the
// "Load Triplex preset" button.

/**
 * Run the Aloui §5 Triplex construction explicitly on the given
 * 6 points. The point order is expected to be
 *     [A, B, C]  bottom triangle
 *     [D, E, F]  top triangle (30° twist)
 * but the function is tolerant of any labeling — it just uses
 * points 0..4 for the seed K₅ and introduces point 5 on the
 * adhesion, then fuses the two diagonals that cross the rotation
 * axis (BD and CE in canonical labeling).
 */
export async function buildTriplexManually(
  points: Vec3[],
  options: Class1SearchOptions = {},
): Promise<Class1SearchResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const state = createEmptyState();
  // Simple state: createYield's getter just closes over the local
  // `state` — nothing else can replace it from outside.
  const driver = createYield(startedAt, deadline, () => state, options);
  const yieldFn = driver.yield;
  const emptyStats: SearchStats = {
    coversTried: 0,
    matchingsTried: 0,
    fusionsTried: 0,
    nodesExpanded: 0,
    bestLpResidual: Infinity,
  };

  if (points.length < 6) {
    logEvent(state, {
      kind: 'failure',
      message: `Triplex needs 6 points, got ${points.length}`,
    });
    await yieldFn('aborted · need 6 points');
    return {
      state,
      success: false,
      rigid: false,
      class1: false,
      numPoints: points.length,
      timedOut: false,
      bestClassK: 0,
      allConnected: false,
      elapsedMs: Date.now() - startedAt,
      searchStats: emptyStats,
      bestResultNote: 'Triplex demo',
    };
  }

  logEvent(state, {
    kind: 'phase',
    message: `Phase 0 — Triplex demo (6 canonical points, timeout ${timeoutMs} ms)`,
  });
  await yieldFn('Phase 0 · Triplex preset');

  // Step 1: seed K₅ on points 0..4  (canonical label {A, B, C, D, E}).
  const seedCell = initializeK5(state, points.slice(0, 5));
  if (!seedCell) {
    logEvent(state, { kind: 'failure', message: 'initializeK5 failed' });
    await yieldFn('aborted · seed failed');
    return {
      state, success: false, rigid: false, class1: false,
      numPoints: points.length, timedOut: false,
      bestClassK: 0,
      allConnected: false,
      elapsedMs: Date.now() - startedAt,
      searchStats: emptyStats,
      bestResultNote: 'Triplex demo',
    };
  }
  const [nA, nB, nC, nD, nE] = seedCell.node_ids;
  logEvent(state, {
    kind: 'init',
    message: `Seed K₅ {A,B,C,D,E} placed (dim W → ${state.selfStressStates.length})`,
    cell_id: seedCell.cell_id,
    node_ids: seedCell.node_ids,
  });
  await yieldFn('Triplex · seed K₅');

  // Step 2: adhere the second K₅ on shared {B, C, D, E}, new node = F.
  const adh = adhereCell(state, [nB, nC, nD, nE], [points[5]]);
  if (!adh) {
    logEvent(state, { kind: 'failure', message: 'adhereCell for BCDEF failed' });
    await yieldFn('aborted · adhesion failed');
    return {
      state, success: false, rigid: false, class1: false,
      numPoints: points.length, timedOut: false,
      bestClassK: 0,
      allConnected: false,
      elapsedMs: Date.now() - startedAt,
      searchStats: emptyStats,
      bestResultNote: 'Triplex demo',
    };
  }
  const nF = adh.addedNodeIds[0];
  logEvent(state, {
    kind: 'adhesion',
    message:
      `Adhered K₅ {B,C,D,E,F} (shared 4, new 1), ` +
      `dim W → ${state.selfStressStates.length}`,
    cell_id: adh.cellId,
    member_ids: adh.addedMemberIds,
    dim_W_after: state.selfStressStates.length,
  });
  await yieldFn('Triplex · adhere BCDEF');

  // Step 3: find and fuse the BD and CE diagonal members.
  const findMember = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return state.members.find(m => m.node_a === lo && m.node_b === hi);
  };
  const mBD = findMember(nB, nD);
  const mCE = findMember(nC, nE);
  if (!mBD || !mCE) {
    logEvent(state, {
      kind: 'failure',
      message: `Could not locate both BD (${mBD ? 'ok' : 'missing'}) and CE (${mCE ? 'ok' : 'missing'}) members`,
    });
    await yieldFn('aborted · missing fuse targets');
    return {
      state, success: false, rigid: false, class1: false,
      numPoints: points.length, timedOut: false,
      bestClassK: 0,
      allConnected: false,
      elapsedMs: Date.now() - startedAt,
      searchStats: emptyStats,
      bestResultNote: 'Triplex demo',
    };
  }

  fuseOneEdge(state, mBD.member_id);
  logEvent(state, {
    kind: 'fusion',
    message: `Fused BD → dim W ${state.selfStressStates.length}`,
    member_ids: [mBD.member_id],
    dim_W_after: state.selfStressStates.length,
  });
  await yieldFn('Triplex · fuse BD');

  fuseOneEdge(state, mCE.member_id);
  logEvent(state, {
    kind: 'fusion',
    message: `Fused CE → dim W ${state.selfStressStates.length}`,
    member_ids: [mCE.member_id],
    dim_W_after: state.selfStressStates.length,
  });
  await yieldFn('Triplex · fuse CE');

  // Phase 4 validation reusing the same helpers as the main flow.
  logEvent(state, { kind: 'phase', message: 'Phase 4 — validation' });
  await yieldFn('Phase 4 · validation');

  const rigidResult = validateRigidity(state);
  const rigid = rigidResult.infinitesimallyRigid || rigidResult.prestressStable;
  logEvent(state, {
    kind: rigid ? 'info' : 'failure',
    message:
      `V3 rigidity: rank=${rigidResult.rank} / ${3 * state.nodes.length - 6}, ` +
      `mechanisms=${rigidResult.dimMechanism}, dim W=${rigidResult.dimW}, ` +
      `infRigid=${rigidResult.infinitesimallyRigid}, ` +
      `prestressStable=${rigidResult.prestressStable}`,
  });

  const signCheck = validateSignConsistency(state);
  if (!signCheck.ok) {
    logEvent(state, {
      kind: 'failure',
      message:
        `V1 sign consistency FAILED on ${signCheck.violations.length} members: ` +
        signCheck.violations.slice(0, 5)
          .map(v => `#${v.id}(${v.type}, q=${v.q.toExponential(2)})`)
          .join(', '),
      member_ids: signCheck.violations.map(v => v.id),
    });
  }

  const class1 = validateMatching(state);
  const prestress = validatePrestressStability(state);
  logEvent(state, {
    kind: prestress.ok ? 'info' : 'failure',
    message:
      `V4 prestress stability: min eig(Ω) = ${prestress.minEig.toExponential(2)} ` +
      `(${prestress.ok ? 'OK' : 'FAIL'})`,
  });

  // Record the final matching as state.matching so the UI's
  // inspector highlight works the same as after a normal search.
  state.matching = state.members
    .filter(m => m.type === 'strut')
    .map(m => m.member_id);

  const elapsedMs = Date.now() - startedAt;
  const allOK = rigid && class1 && signCheck.ok;
  logEvent(state, {
    kind: allOK ? 'success' : 'info',
    message:
      `Triplex demo done — struts=${state.matching.length}, ` +
      `rigid=${rigid}, class1=${class1}, signs=${signCheck.ok}`,
  });
  await yieldFn('done · Triplex demo');

  // Class-k of the final Triplex state
  const strutCount = new Map<number, number>();
  for (const m of state.members.filter(m => m.type === 'strut')) {
    strutCount.set(m.node_a, (strutCount.get(m.node_a) ?? 0) + 1);
    strutCount.set(m.node_b, (strutCount.get(m.node_b) ?? 0) + 1);
  }
  let classK = 0;
  for (const c of strutCount.values()) if (c > classK) classK = c;
  const connected = new Set<number>();
  for (const m of state.members) { connected.add(m.node_a); connected.add(m.node_b); }
  const allConnectedTri = state.nodes.every(nn => connected.has(nn.node_id));

  return {
    state,
    success: allOK,
    rigid,
    class1,
    numPoints: points.length,
    bestClassK: classK,
    allConnected: allConnectedTri,
    timedOut: false,
    elapsedMs,
    searchStats: emptyStats,
    bestResultNote: allOK ? 'Triplex construction succeeded' : 'Triplex construction did not validate',
  };
}

// ─── helpers ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allCombinations4(n: number): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          out.push([a, b, c, d]);
  return out;
}

function sampleCombinations4(n: number, k: number, rng: () => number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < k; i++) {
    const a = Math.floor(rng() * n);
    let b = Math.floor(rng() * n); while (b === a) b = Math.floor(rng() * n);
    let c = Math.floor(rng() * n); while (c === a || c === b) c = Math.floor(rng() * n);
    let d = Math.floor(rng() * n); while (d === a || d === b || d === c) d = Math.floor(rng() * n);
    out.push([a, b, c, d]);
  }
  return out;
}

