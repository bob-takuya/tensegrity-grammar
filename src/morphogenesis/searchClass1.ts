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
import { createEmptyState, initializeK5, logEvent, assignForceDensities } from './engine';
import { adhereCell, suggestNewPositions } from './adhesion';
import { fuseOneEdge } from './fusion';
import { buildK5Cover } from './k5cover';
import { buildEquilibriumMatrix, nullspace, symmetricEigenvalues } from './linalg';
import { lpClass1Check, lpPairCheck } from './lp';
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
  state: MorphogenesisState,
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
      state,
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

async function buildStructureFromCover(
  P: Vec3[],
  state: MorphogenesisState,
  yieldFn: YieldFn,
): Promise<boolean> {
  const cover = buildK5Cover(P);
  if (cover.length === 0) return false;

  logEvent(state, {
    kind: 'phase',
    message: `Phase 1 — K₅ cover built (${cover.length} cells)`,
  });
  if (await yieldFn('Phase 1 · K₅ cover')) return true;

  // Seed cell
  const seedIdx = cover[0].newIdx;
  const seedPoints = seedIdx.map(i => P[i]);
  const seedCell = initializeK5(state, seedPoints);
  if (!seedCell) return false;
  // Map source-point index → runtime node_id
  const nodeIdOf = new Map<number, number>();
  seedIdx.forEach((srcIdx, k) => nodeIdOf.set(srcIdx, seedCell.node_ids[k]));
  if (await yieldFn('Phase 2 · seed K₅')) return true;

  logEvent(state, {
    kind: 'phase',
    message: 'Phase 2 — Cellular morphogenesis (adhesion loop)',
  });

  for (let step = 1; step < cover.length; step++) {
    // Deadline check at the top of the loop — we'd rather have a
    // partially-built but visible structure than an abrupt timeout
    // mid-adhesion, so we bail cleanly on the boundary.
    if (await yieldFn(`Phase 2 · cell ${step}/${cover.length - 1}`)) return true;
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
    if (await yieldFn(`Phase 2 · cell ${step}/${cover.length - 1} adhered`)) return true;
  }

  return true;
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
 * Grow dim W by one by adhering a brand-new K₅ cell that shares 4
 * existing nodes with the current structure. By the Maxwell-rule
 * corollary, a 4-shared adhesion adds Δe − 3 Δv = 4 − 3 = 1 new
 * column to W, so repeated calls are guaranteed to raise dim W until
 * it exceeds |M| + 3 and the Class-1 LP becomes solvable in principle.
 *
 * We sample candidate 4-node faces up to `maxTries` times and keep the
 * first adhesion the engine accepts.
 */
function addAdhesionForDim(
  state: MorphogenesisState,
  maxTries: number = 20,
): boolean {
  if (state.nodes.length < 4) return false;
  const nodeIds = state.nodes.map(n => n.node_id);

  for (let t = 0; t < maxTries; t++) {
    // Pick 4 distinct existing nodes uniformly at random.
    const chosen: number[] = [];
    const pool = [...nodeIds];
    for (let k = 0; k < 4 && pool.length > 0; k++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool[idx]);
      pool.splice(idx, 1);
    }
    if (chosen.length < 4) return false;
    const newPos = suggestNewPositions(state, chosen, 1.5);
    const res = adhereCell(state, chosen, newPos);
    if (res) {
      logEvent(state, {
        kind: 'adhesion',
        message:
          `dim-W growth: adhered K₅ on face ${chosen.join(',')} ` +
          `(+${res.addedMemberIds.length} members, dim W → ${state.selfStressStates.length})`,
        cell_id: res.cellId,
        member_ids: res.addedMemberIds,
        dim_W_after: state.selfStressStates.length,
      });
      return true;
    }
  }
  return false;
}

async function enforceClass1(
  state: MorphogenesisState,
  yieldFn: YieldFn,
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
  const MAX_ADHESION_GROWS = 3;  // bound dim-W growth so small-n runs terminate
  const SIGN_EPS = 1e-8;
  logEvent(state, { kind: 'phase', message: 'Phase 3 — Class-1 enforcement' });
  if (await yieldFn('Phase 3 · enforce Class-1')) {
    return { success: false, alpha: [], matching: [], timedOut: true };
  }

  let perturbSeed = 0;
  let adhesionGrowCount = 0;

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
    // Priority: edges with the largest absolute first-basis value.
    const firstBasis = (e: Edge) => {
      const i = memberIdx.get(e.id);
      if (i === undefined) return 0;
      let s = 0;
      for (let j = 0; j < W[0].length; j++) s += Math.abs(W[i][j]);
      return s;
    };
    const matching = greedyMatching(edges, firstBasis, 12);
    logEvent(state, {
      kind: 'matching',
      message: `Iter ${iter + 1}: matching size ${matching.length} / ⌊n/2⌋=${Math.floor(state.nodes.length / 2)}`,
      matching_ids: [...matching],
    });

    const dimW = state.selfStressStates.length;

    // Step D2: LP feasibility check
    const strutIds = matching;
    const cableIds = edges.filter(e => !matching.includes(e.id)).map(e => e.id);
    const lp = lpClass1Check(W, memberIdx, strutIds, cableIds);

    logEvent(state, {
      kind: 'lp_check',
      message: `LP ${lp.feasible ? 'feasible' : 'infeasible'} (residual=${lp.residual.toExponential(2)})`,
      dim_W_before: dimW,
      dim_W_after: dimW,
    });

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
    if (lp.feasible) {
      // Tentatively apply α with sign-based typing. We snapshot the
      // original member types so we can roll back if the resulting
      // strut set is not a valid matching.
      const savedTypes = state.members.map(m => m.type);
      const savedFD = state.members.map(m => m.force_density);
      const counts = applyAlpha(state, W, lp.alpha, SIGN_EPS);

      const struts = state.members.filter(m => m.type === 'strut');
      const seen = new Set<number>();
      let matchingOK = true;
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
            (counts.numZero > 0 ? `, ${counts.numZero} zero-force` : ''),
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

      // Roll back and treat as infeasible — the LP's sign assignment
      // broke Class-1, so we need to retry with another matching or
      // strategic fusion.
      state.members.forEach((m, i) => {
        m.type = savedTypes[i];
        m.force_density = savedFD[i];
      });
      logEvent(state, {
        kind: 'info',
        message:
          'LP α violates Class-1 when types are derived from sign(w*); ' +
          'treating as infeasible',
      });
    }

    // Step D3: find conflicts
    const conflicts = findConflicts(W, memberIdx, matching, edges);
    logEvent(state, {
      kind: 'conflict',
      message: `Identified ${conflicts.length} LP conflicts`,
      conflict_count: conflicts.length,
    });

    if (conflicts.length === 0) {
      // No pairwise conflict is diagnosable — swap one edge of the
      // matching (ALTERNATIVE_MATCHING) and retry.
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
    const pick = conflicts[0];
    logEvent(state, {
      kind: 'strategic_fusion',
      message:
        `Strategic fusion: dropping cable member #${pick.cableId} ` +
        `(blocking strut #${pick.strutId}), dim W ${dimW} → …`,
      member_ids: [pick.strutId, pick.cableId],
      dim_W_before: dimW,
    });
    fuseOneEdge(state, pick.cableId);
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

function validateRigidity(state: MorphogenesisState): boolean {
  if (state.nodes.length === 0) return false;
  const { A } = buildEquilibriumMatrix(state.nodes, state.members);
  const ker = nullspace(A);
  const rank = state.members.length - ker.length;
  return rank >= 3 * state.nodes.length - 6;
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
  /** True if the search was stopped by the wall-clock deadline. */
  timedOut: boolean;
  /** Wall-clock elapsed time (ms). */
  elapsedMs: number;
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
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // Allocate the state first so the driver can close over it and
  // expose it on every progress tick.
  const state = createEmptyState();
  const driver = createYield(startedAt, deadline, state, options);
  const yieldFn = driver.yield;

  logEvent(state, { kind: 'phase', message: `Phase 0 — preparing ${n} points (timeout ${timeoutMs} ms)` });
  await yieldFn('Phase 0 · preparing points');
  const P = generateOrValidatePoints(n, points, seed);

  const builtOK = await buildStructureFromCover(P, state, yieldFn);
  if (!builtOK) {
    logEvent(state, { kind: 'failure', message: 'Structure build failed' });
    await yieldFn('aborted · build failed');
    return {
      state,
      success: false,
      rigid: false,
      class1: false,
      numPoints: n,
      timedOut: Date.now() >= deadline,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const enforced = await enforceClass1(state, yieldFn);

  // Ensure force densities are populated even when no LP was run (e.g.
  // dim W already 0 after strategic fusions). Must happen BEFORE V1/V4
  // run, otherwise they would be checking the empty state.
  if (!enforced.success) assignForceDensities(state);

  logEvent(state, { kind: 'phase', message: 'Phase 4 — validation' });
  await yieldFn('Phase 4 · validation');

  // V3 — infinitesimal rigidity: rank(A) = 3|V| − 6.
  const rigid = validateRigidity(state);

  // V1 — force-density sign consistency. This is the regression guard
  // for the cable-has-negative-q bug: if any cable's q slipped negative
  // (or any strut's q slipped positive), fail loudly with the offending
  // member ids in the event log.
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

  // V2 — Class-1 matching: every node incident to ≤1 strut.
  const class1 = validateMatching(state);

  // V4 — prestress stability: minimum eigenvalue of the Connelly
  // stress matrix Ω must be ≥ −ε. Only meaningful once q has been
  // assigned, which is why this is last.
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

  // Final progress tick so the UI paints the validated state.
  await yieldFn(enforced.timedOut ? 'done · timeout' : 'done');

  return {
    state,
    success: enforced.success && signCheck.ok,
    rigid,
    class1,
    numPoints: n,
    timedOut: enforced.timedOut,
    elapsedMs,
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

