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
 * Every interesting event is pushed to state.events so the UI can
 * replay the search in real time.
 */

import { MorphogenesisState, Vec3 } from './types';
import { createEmptyState, initializeK5, logEvent, assignForceDensities } from './engine';
import { adhereCell } from './adhesion';
import { fuseOneEdge } from './fusion';
import { buildK5Cover } from './k5cover';
import { buildEquilibriumMatrix, nullspace } from './linalg';
import { lpClass1Check, lpPairCheck } from './lp';
import { greedyMatching, Edge } from './matching';
import { vol } from './geometry';

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

function buildStructureFromCover(
  P: Vec3[],
  state: MorphogenesisState,
): boolean {
  const cover = buildK5Cover(P);
  if (cover.length === 0) return false;

  logEvent(state, {
    kind: 'phase',
    message: `Phase 1 — K₅ cover built (${cover.length} cells)`,
  });

  // Seed cell
  const seedIdx = cover[0].newIdx;
  const seedPoints = seedIdx.map(i => P[i]);
  const seedCell = initializeK5(state, seedPoints);
  if (!seedCell) return false;
  // Map source-point index → runtime node_id
  const nodeIdOf = new Map<number, number>();
  seedIdx.forEach((srcIdx, k) => nodeIdOf.set(srcIdx, seedCell.node_ids[k]));

  logEvent(state, {
    kind: 'phase',
    message: 'Phase 2 — Cellular morphogenesis (adhesion loop)',
  });

  for (let step = 1; step < cover.length; step++) {
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

/** Materialise Wα and copy it into MEMBER.force_density + type. */
function applyAlpha(
  state: MorphogenesisState,
  W: number[][],
  alpha: number[],
  strutIds: Set<number>,
): void {
  state.alpha = [...alpha];
  for (let i = 0; i < state.members.length; i++) {
    let v = 0;
    for (let j = 0; j < W[0].length; j++) v += W[i][j] * alpha[j];
    const m = state.members[i];
    m.force_density = v;
    if (strutIds.has(m.member_id)) m.type = 'strut';
    else m.type = 'cable';
  }
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

function enforceClass1(state: MorphogenesisState): {
  success: boolean;
  alpha: number[];
  matching: number[];
} {
  const MAX_ITER = 40;
  logEvent(state, { kind: 'phase', message: 'Phase 3 — Class-1 enforcement' });

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const { W, memberIdx } = denseW(state);
    if (W.length === 0 || W[0].length === 0) {
      logEvent(state, {
        kind: 'failure',
        message: 'No self-stress basis left — giving up',
      });
      return { success: false, alpha: [], matching: [] };
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

    // Step D2: LP feasibility check
    const strutIds = matching;
    const cableIds = edges.filter(e => !matching.includes(e.id)).map(e => e.id);
    const lp = lpClass1Check(W, memberIdx, strutIds, cableIds);

    logEvent(state, {
      kind: 'lp_check',
      message: `LP ${lp.feasible ? 'feasible' : 'infeasible'} (residual=${lp.residual.toExponential(2)})`,
      dim_W_before: state.selfStressStates.length,
      dim_W_after: state.selfStressStates.length,
    });

    if (lp.feasible) {
      applyAlpha(state, W, lp.alpha, new Set(strutIds));
      state.matching = [...strutIds];
      logEvent(state, {
        kind: 'success',
        message: `Class-1 reached: ${strutIds.length} struts, ${cableIds.length} cables`,
        matching_ids: [...strutIds],
      });
      return { success: true, alpha: lp.alpha, matching: strutIds };
    }

    // Step D3: find conflicts
    const conflicts = findConflicts(W, memberIdx, matching, edges);
    logEvent(state, {
      kind: 'conflict',
      message: `Identified ${conflicts.length} LP conflicts`,
      conflict_count: conflicts.length,
    });

    if (conflicts.length === 0) {
      logEvent(state, {
        kind: 'info',
        message: 'No direct conflicts; falling through to heuristic α',
      });
      applyAlpha(state, W, lp.alpha, new Set(strutIds));
      state.matching = [...strutIds];
      return { success: false, alpha: lp.alpha, matching: strutIds };
    }

    // Step D4: strategic fusion. We zero out the highest-priority
    // blocking member from W using fuseSelfStress — this drops dim W
    // by 1 and severs the offending sign coupling. We refuse to fuse
    // below dim W = 1, since that would leave the structure with no
    // self-stress at all.
    const dimBefore = state.selfStressStates.length;
    if (dimBefore <= 1) {
      logEvent(state, {
        kind: 'failure',
        message: 'Cannot fuse further: dim W already at 1',
      });
      applyAlpha(state, W, lp.alpha, new Set(strutIds));
      state.matching = [...strutIds];
      return { success: false, alpha: lp.alpha, matching: strutIds };
    }
    const pick = conflicts[0];
    logEvent(state, {
      kind: 'strategic_fusion',
      message:
        `Strategic fusion: dropping cable member #${pick.cableId} ` +
        `(blocking strut #${pick.strutId}), dim W ${dimBefore} → …`,
      member_ids: [pick.strutId, pick.cableId],
      dim_W_before: dimBefore,
    });
    fuseOneEdge(state, pick.cableId);
  }

  logEvent(state, { kind: 'failure', message: 'Max iterations reached' });
  return { success: false, alpha: [], matching: [] };
}

// ─── Phase 4: validation ───────────────────────────────────

function validateRigidity(state: MorphogenesisState): boolean {
  if (state.nodes.length === 0) return false;
  const { A } = buildEquilibriumMatrix(state.nodes, state.members);
  const ker = nullspace(A);
  const rank = state.members.length - ker.length;
  return rank >= 3 * state.nodes.length - 6;
}

function validateMatching(state: MorphogenesisState): boolean {
  const struts = state.members.filter(m => m.type === 'strut');
  const seen = new Set<number>();
  for (const s of struts) {
    if (seen.has(s.node_a) || seen.has(s.node_b)) return false;
    seen.add(s.node_a); seen.add(s.node_b);
  }
  return true;
}

// ─── Entry point ───────────────────────────────────────────

export interface Class1SearchResult {
  state: MorphogenesisState;
  success: boolean;
  rigid: boolean;
  class1: boolean;
  numPoints: number;
}

/**
 * Top-level entry point. Mirrors the ALGORITHM block of the spec.
 * Does not throw on failure; instead populates `state.events` with
 * a trail that the UI can display.
 */
export function searchClass1Tensegrity(
  n: number,
  points: Vec3[] | null = null,
  seed?: number,
): Class1SearchResult {
  const state = createEmptyState();

  logEvent(state, { kind: 'phase', message: `Phase 0 — preparing ${n} points` });
  const P = generateOrValidatePoints(n, points, seed);

  const builtOK = buildStructureFromCover(P, state);
  if (!builtOK) {
    logEvent(state, { kind: 'failure', message: 'Structure build failed' });
    return { state, success: false, rigid: false, class1: false, numPoints: n };
  }

  const enforced = enforceClass1(state);

  logEvent(state, { kind: 'phase', message: 'Phase 4 — validation' });
  const rigid = validateRigidity(state);
  const class1 = validateMatching(state);
  logEvent(state, {
    kind: rigid && class1 && enforced.success ? 'success' : 'info',
    message: `Validation: rigid=${rigid}, class1=${class1}, lp=${enforced.success}`,
  });

  // Ensure force densities are populated even when no LP was run (e.g.
  // dim W already 0 after strategic fusions).
  if (!enforced.success) assignForceDensities(state);

  return {
    state,
    success: enforced.success,
    rigid,
    class1,
    numPoints: n,
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

