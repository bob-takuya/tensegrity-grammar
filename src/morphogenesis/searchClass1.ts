/**
 * Class-1 Tensegrity Search — K_n null space algorithm
 * ─────────────────────────────────────────────────────
 * Given n points in ℝ³, search for a Class-1 tensegrity on those
 * nodes by:
 *
 *   Phase 0: validate / generate the n points
 *   Phase 1: build the complete graph K_n on n nodes; compute
 *            W = null(A_Kn), the full self-stress space
 *   Phase 2: enumerate strutness-priority + length + random
 *            maximum matchings as candidate strut sets
 *   Phase 3: for each candidate matching M, run a STRUT-ONLY
 *            LP asking for α with (Wα)_e ≤ -ε ∀ e ∈ M
 *   Phase 4: classify edges by sign(Wα) into strut/cable/zero,
 *            DELETE zero-force edges, and validate rigidity
 *            (V3 infinitesimal rigidity OR V4 prestress
 *            stability)
 *
 * Compared with the previous K₅-cover + adhesion + fusion
 * pipeline, this approach computes the entire self-stress space
 * in a single null space call and lets the LP pick out a
 * tensegrity from inside it. Empirically it succeeds on every
 * known structure (Triplex, 4-prism, 5-prism, tensegrity
 * icosahedron, 3-stage Snelson tower).
 */

import { MorphogenesisState, Vec3 } from './types';
import {
  createEmptyState,
  deepCloneState,
  logEvent,
  assignForceDensities,
} from './engine';
import { buildEquilibriumMatrix, nullspace, symmetricEigenvalues } from './linalg';
import { lpStrutOnly } from './lp';
import {
  buildKnStructure,
  computeWAlpha,
  classifyKnEdges,
  applyClassificationAndPrune,
  generateMatchingCandidates,
} from './kn';
import { maximumMatching } from './matching';
import { vol } from './geometry';

// ─── Search driver / progress plumbing ─────────────────────

export interface SearchProgress {
  phase: string;
  tick: number;
  elapsedMs: number;
  remainingMs: number;
  deadlineReached: boolean;
  state: MorphogenesisState;
}

export interface Class1SearchOptions {
  /** Wall-clock budget for the whole search. Default 10 s. */
  timeoutMs?: number;
  /** Called after every significant mutation of `state`. */
  onProgress?: (progress: SearchProgress) => void;
  /** Optional caller-controlled cancel signal. */
  signal?: AbortSignal;
  /**
   * When true (the default in UI flows) the driver awaits a macrotask
   * between ticks so React can re-render and the browser can paint.
   * Set to false from Node test scripts to run at full speed.
   */
  yieldToEventLoop?: boolean;
  /**
   * Maximum number of random matchings to inject into the candidate
   * pool on top of the deterministic strutness/length matchings.
   * Larger = more thorough, slower. Default 30.
   */
  maxRandomMatchings?: number;
  /**
   * Reserved for backwards compatibility with the old K₅-cover
   * driver. Ignored by the new K_n algorithm.
   */
  maxCoverCandidates?: number;
}

export interface SearchStats {
  /** Always 1 in the new algorithm — kept for UI stat compatibility. */
  coversTried: number;
  /** Number of candidate matchings the LP was actually invoked on. */
  matchingsTried: number;
  /** Always 0 — fusion no longer exists. */
  fusionsTried: number;
  /** Phase-3 iterations attempted (= matchings explored). */
  nodesExpanded: number;
  /** Smallest LP hinge-loss residual observed across all matchings. */
  bestLpResidual: number;
  /** Always 0 — kept for UI stat compatibility. */
  preflightSkips: number;
}

interface BestResult {
  state: MorphogenesisState;
  matching: number[];
  classK: number;
  numMembers: number;
  numStruts: number;
  allConnected: boolean;
  lpResidual: number;
  success: boolean;
  rigid: boolean;
}

function scoreBestResult(r: BestResult): number {
  if (r.success && r.rigid) return Number.NEGATIVE_INFINITY;
  if (!r.allConnected) return Number.POSITIVE_INFINITY;
  return (
    (r.success ? 0 : 1e7) +
    (r.rigid ? 0 : 5e6) +
    r.classK * 1000 +
    r.numMembers * 1 +
    (Number.isFinite(r.lpResidual) ? r.lpResidual * 0.1 : 1e6)
  );
}

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

// ─── Phase 0: input point validation ───────────────────────

export function generateOrValidatePoints(
  n: number,
  points: Vec3[] | null,
  seed?: number,
): Vec3[] {
  if (n < 4) throw new Error('n must be ≥ 4');
  let rng = mulberry32(seed ?? Date.now());

  let P: Vec3[];
  if (points && points.length >= n) {
    P = points.slice(0, n).map((p) => [p[0], p[1], p[2]] as Vec3);
  } else {
    P = Array.from(
      { length: n },
      () => [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1] as Vec3,
    );
  }

  // General-position sanity: every 4-tuple should have non-zero
  // tetrahedral volume so K_n is non-degenerate. Perturb slightly
  // when violated.
  const maxChecks = 1000;
  const combos =
    n <= 15 ? allCombinations4(n) : sampleCombinations4(n, maxChecks, rng);
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

// ─── Validation helpers (unchanged from previous version) ──

interface RigidityResult {
  infinitesimallyRigid: boolean;
  prestressStable: boolean;
  rank: number;
  dimMechanism: number;
  dimW: number;
}

function validateRigidity(state: MorphogenesisState): RigidityResult {
  if (state.nodes.length === 0 || state.members.length === 0) {
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
  // dim W of the LIVE structure (after pruning). We recompute it
  // here from the post-prune A, not from state.selfStressStates,
  // which still reflects the pre-prune K_n basis.
  const dimW = ker.length;
  const dimMechanism = Math.max(0, expectedGenericRank - rank);
  const infinitesimallyRigid = dimMechanism === 0;
  const prestressStable = dimW > 0 && dimMechanism <= dimW;
  return {
    infinitesimallyRigid,
    prestressStable,
    rank,
    dimMechanism,
    dimW,
  };
}

function validateMatching(state: MorphogenesisState): boolean {
  const struts = state.members.filter((m) => m.type === 'strut');
  if (struts.length === 0) return false;
  const seen = new Set<number>();
  for (const s of struts) {
    if (seen.has(s.node_a) || seen.has(s.node_b)) return false;
    seen.add(s.node_a);
    seen.add(s.node_b);
  }
  return true;
}

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

function validatePrestressStability(
  state: MorphogenesisState,
  eps: number = 1e-6,
): { ok: boolean; minEig: number } {
  const n = state.nodes.length;
  if (n === 0) return { ok: true, minEig: 0 };
  const idx = new Map<number, number>();
  state.nodes.forEach((nd, i) => idx.set(nd.node_id, i));

  const Omega: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0),
  );
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

// ─── Best-result tracking ──────────────────────────────────

function snapshotBest(
  state: MorphogenesisState,
  lpResidual: number,
  success: boolean,
  rigid: boolean,
): BestResult {
  const connected = new Set<number>();
  for (const m of state.members) {
    if (m.type === 'candidate') continue;
    connected.add(m.node_a);
    connected.add(m.node_b);
  }
  const allConnected = state.nodes.every((n) => connected.has(n.node_id));

  const strutCount = new Map<number, number>();
  const struts = state.members.filter((m) => m.type === 'strut');
  for (const m of struts) {
    strutCount.set(m.node_a, (strutCount.get(m.node_a) ?? 0) + 1);
    strutCount.set(m.node_b, (strutCount.get(m.node_b) ?? 0) + 1);
  }
  let classK = 0;
  for (const c of strutCount.values()) if (c > classK) classK = c;
  const effectiveClassK = struts.length > 0 ? classK : Number.POSITIVE_INFINITY;

  return {
    state: deepCloneState(state),
    matching: [...state.matching],
    classK: effectiveClassK,
    numMembers: state.members.length,
    numStruts: struts.length,
    allConnected,
    lpResidual,
    success,
    rigid,
  };
}

function updateBest(
  current: BestResult | null,
  candidate: BestResult,
): BestResult {
  if (current === null) return candidate;
  return scoreBestResult(candidate) < scoreBestResult(current)
    ? candidate
    : current;
}

function describeBest(best: BestResult): string {
  if (best.success && best.rigid) {
    return `Class-1 tensegrity found (${best.numStruts} struts, rigid)`;
  }
  const parts: string[] = [];
  if (!best.allConnected) parts.push('unconnected nodes');
  if (Number.isFinite(best.classK)) parts.push(`Class-${best.classK}`);
  else parts.push('no struts');
  parts.push(`${best.numMembers} members`);
  parts.push(`${best.numStruts} struts`);
  if (!best.rigid) parts.push('not rigid');
  if (Number.isFinite(best.lpResidual)) {
    parts.push(`LP residual=${best.lpResidual.toExponential(2)}`);
  }
  return `best: ${parts.join(', ')}`;
}

// ─── Top-level entry point ─────────────────────────────────

export interface Class1SearchResult {
  state: MorphogenesisState;
  success: boolean;
  rigid: boolean;
  class1: boolean;
  numPoints: number;
  bestClassK: number;
  allConnected: boolean;
  timedOut: boolean;
  elapsedMs: number;
  searchStats: SearchStats;
  bestResultNote: string;
}

export async function searchClass1Tensegrity(
  n: number,
  points: Vec3[] | null = null,
  seed?: number,
  options: Class1SearchOptions = {},
): Promise<Class1SearchResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const maxRandomMatchings = options.maxRandomMatchings ?? 30;

  const stats: SearchStats = {
    coversTried: 1,
    matchingsTried: 0,
    fusionsTried: 0,
    nodesExpanded: 0,
    bestLpResidual: Number.POSITIVE_INFINITY,
    preflightSkips: 0,
  };

  const state = createEmptyState();
  const driver = createYield(startedAt, deadline, () => state, options);
  const yieldFn = driver.yield;

  // ── Phase 0: points ────────────────────────────────────
  logEvent(state, {
    kind: 'phase',
    message: `Phase 0 — preparing ${n} points (timeout ${timeoutMs} ms)`,
  });
  await yieldFn('Phase 0 · preparing points');
  const P = generateOrValidatePoints(n, points, seed);

  // ── Phase 1: K_n + W ────────────────────────────────────
  logEvent(state, {
    kind: 'phase',
    message: `Phase 1 — building K_${n} and computing W = null(A)`,
  });
  const { W, memberIdx, dimW } = buildKnStructure(state, P);
  logEvent(state, {
    kind: 'init',
    message:
      `K_${n} built: ${state.nodes.length} nodes, ${state.members.length} members, ` +
      `dim W = ${dimW}`,
    dim_W_after: dimW,
  });
  if (await yieldFn('Phase 1 · K_n null space')) {
    return finalize(state, null, stats, n, startedAt, true);
  }

  if (dimW === 0) {
    logEvent(state, {
      kind: 'failure',
      message: 'dim W = 0: K_n has trivial null space; no tensegrity exists',
    });
    return finalize(state, null, stats, n, startedAt, false);
  }

  // ── Phase 2: matching candidates ────────────────────────
  logEvent(state, {
    kind: 'phase',
    message: `Phase 2 — enumerating candidate matchings (random budget ${maxRandomMatchings})`,
  });
  const candidates = generateMatchingCandidates(state, W, memberIdx, {
    randomCount: maxRandomMatchings,
    seed: seed ?? 1,
  });
  logEvent(state, {
    kind: 'info',
    message: `Phase 2 — ${candidates.length} distinct candidate matchings ready`,
  });
  await yieldFn('Phase 2 · matchings enumerated');

  // ── Phase 3+4: try each matching, classify, validate ────
  logEvent(state, {
    kind: 'phase',
    message: 'Phase 3 — strut-only LP per matching',
  });
  // We snapshot the original K_n state so each attempt starts fresh.
  // Cloning the full K_n state is cheap (it has no fusion history).
  const baseClone = deepCloneState(state);
  const baseW = W;
  const baseMemberIdx = memberIdx;

  let bestHolder: BestResult | null = null;

  for (let ci = 0; ci < candidates.length; ci++) {
    if (await yieldFn(`Phase 3 · matching ${ci + 1}/${candidates.length}`)) {
      // Time's up.
      break;
    }
    const cand = candidates[ci];
    stats.matchingsTried++;
    stats.nodesExpanded++;

    // Reset state to the clean K_n background for each attempt,
    // preserving the running events log so the UI sees per-iter
    // progress instead of a pristine clean slate every time.
    restoreState(state, baseClone, /* preserveEvents */ true);

    logEvent(state, {
      kind: 'matching',
      message:
        `Iter ${ci + 1}: ${cand.source} matching, size ${cand.ids.length} / ⌊n/2⌋=${Math.floor(n / 2)}`,
      matching_ids: [...cand.ids],
    });

    const lp = lpStrutOnly(baseW, baseMemberIdx, cand.ids);
    if (lp.residual < stats.bestLpResidual) stats.bestLpResidual = lp.residual;
    logEvent(state, {
      kind: 'lp_check',
      message:
        `LP ${lp.feasible ? 'feasible' : 'infeasible'} ` +
        `(residual=${lp.residual.toExponential(2)})`,
    });
    if (!lp.feasible) {
      // Track best residual snapshot so the UI gets a non-empty
      // result even on total failure.
      bestHolder = updateBest(
        bestHolder,
        snapshotBest(state, lp.residual, false, false),
      );
      continue;
    }

    // Classify edges by sign(Wα) and prune zero-force ones.
    const wStar = computeWAlpha(baseW, lp.alpha);
    const cls = classifyKnEdges(state.members, wStar, baseMemberIdx);
    logEvent(state, {
      kind: 'info',
      message:
        `sign(Wα): ${cls.strutIds.length} struts, ${cls.cableIds.length} cables, ` +
        `${cls.zeroIds.length} zero-force (signEps=${cls.signEps.toExponential(2)})`,
    });

    // Class-1 reconciliation. The LP only constrains members in M
    // to be strut-signed; nothing stops it from making EXTRA
    // members negative as well (the K_n null space is 10-50
    // dimensional for n ≥ 8, so there's plenty of room). When the
    // raw negative set isn't a Class-1 matching, fall back to
    // a maximum matching computed *on the negatives only*: that
    // gives us the largest possible Class-1 subset of "edges the
    // LP wants compressed". Any negative outside this matching
    // gets pruned as zero-force (we treat its compressive force
    // as numerical noise that doesn't survive into the final
    // structure), and any positive outside is a cable as usual.
    const usedNodes = new Set<number>();
    let initiallyClass1 = cls.strutIds.length > 0;
    for (const sid of cls.strutIds) {
      const m = state.members.find((x) => x.member_id === sid);
      if (!m) { initiallyClass1 = false; break; }
      if (usedNodes.has(m.node_a) || usedNodes.has(m.node_b)) {
        initiallyClass1 = false;
        break;
      }
      usedNodes.add(m.node_a);
      usedNodes.add(m.node_b);
    }
    if (!initiallyClass1) {
      // Run blossom maximum matching over the negative edges to
      // extract the largest Class-1 strut subset.
      const negEdges = cls.strutIds
        .map((sid) => state.members.find((x) => x.member_id === sid))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ id: m.member_id, node_a: m.node_a, node_b: m.node_b }));
      // Priority = magnitude of (Wα)_e: keep the strongest
      // compressive forces in the matching, weakest first to be
      // pruned as zero-force.
      const subMatching = maximumMatching(negEdges, (e) => {
        const r = baseMemberIdx.get(e.id);
        return r !== undefined ? -wStar[r] : 0;
      });
      if (subMatching.length === 0) {
        bestHolder = updateBest(
          bestHolder,
          snapshotBest(state, lp.residual, false, false),
        );
        continue;
      }
      // Prune the negatives that didn't make it into the
      // class-1 sub-matching: add them to zeroIds so the
      // pruning step deletes them.
      const keepStruts = new Set(subMatching);
      const droppedStruts: number[] = [];
      for (const sid of cls.strutIds) {
        if (!keepStruts.has(sid)) droppedStruts.push(sid);
      }
      cls.strutIds = subMatching;
      cls.zeroIds = [...cls.zeroIds, ...droppedStruts];
      logEvent(state, {
        kind: 'info',
        message:
          `sign(Wα) had ${cls.strutIds.length + droppedStruts.length} negatives; ` +
          `extracted Class-1 sub-matching of size ${cls.strutIds.length}, ` +
          `pruning ${droppedStruts.length} extra struts as zero-force`,
      });
    }

    // Connectivity repair: the algorithm must NEVER drop an
    // input point. If the sign-based classification would leave
    // some input node with no incident live member, restore the
    // strongest zero-force edges (by |Wα|) incident to each
    // isolated node as cables. We classify the repaired edges as
    // cables regardless of their w* sign so the operation never
    // introduces a new Class-1 violation; the user trade-off is
    // that their force density may be slightly off — an
    // acceptable cost per the spec "always show all n points".
    //
    // This is done BEFORE applyClassificationAndPrune so the
    // pruning step leaves the repaired edges intact.
    {
      const strutSet = new Set(cls.strutIds);
      const cableSet = new Set(cls.cableIds);
      const incident = new Map<number, number[]>();
      for (const m of state.members) {
        if (!incident.has(m.node_a)) incident.set(m.node_a, []);
        if (!incident.has(m.node_b)) incident.set(m.node_b, []);
        incident.get(m.node_a)!.push(m.member_id);
        incident.get(m.node_b)!.push(m.member_id);
      }
      const memberById = new Map(state.members.map((m) => [m.member_id, m]));
      const touched = new Set<number>();
      for (const sid of cls.strutIds) {
        const m = memberById.get(sid);
        if (m) { touched.add(m.node_a); touched.add(m.node_b); }
      }
      for (const cid of cls.cableIds) {
        const m = memberById.get(cid);
        if (m) { touched.add(m.node_a); touched.add(m.node_b); }
      }
      const zeroSet = new Set(cls.zeroIds);
      const repaired: number[] = [];
      for (const nd of state.nodes) {
        if (touched.has(nd.node_id)) continue;
        // Find strongest |Wα| edge incident to this node that is
        // currently zero-force.
        const incidentIds = incident.get(nd.node_id) ?? [];
        let best: number | null = null;
        let bestAbs = -1;
        for (const mid of incidentIds) {
          if (!zeroSet.has(mid)) continue;
          const row = baseMemberIdx.get(mid);
          if (row === undefined) continue;
          const av = Math.abs(wStar[row]);
          if (av > bestAbs) { bestAbs = av; best = mid; }
        }
        if (best === null && incidentIds.length > 0) {
          // Even the zero-force pool is empty for this node — fall
          // back to any incident edge with the strongest absolute
          // w* that isn't already a strut (to avoid Class-1 breakage).
          for (const mid of incidentIds) {
            if (strutSet.has(mid)) continue;
            const row = baseMemberIdx.get(mid);
            if (row === undefined) continue;
            const av = Math.abs(wStar[row]);
            if (av > bestAbs) { bestAbs = av; best = mid; }
          }
        }
        if (best !== null) {
          zeroSet.delete(best);
          cableSet.add(best);
          repaired.push(best);
          const mm = memberById.get(best);
          if (mm) { touched.add(mm.node_a); touched.add(mm.node_b); }
        }
      }
      if (repaired.length > 0) {
        cls.zeroIds = [...zeroSet];
        cls.cableIds = [...cableSet];
        logEvent(state, {
          kind: 'info',
          message:
            `Connectivity repair: restored ${repaired.length} zero-force edges ` +
            `as cables to keep every input point connected`,
        });
      }
    }

    // Commit α + types + zero-force pruning.
    state.alpha = [...lp.alpha];
    state.matching = [...cls.strutIds];
    applyClassificationAndPrune(state, wStar, baseMemberIdx, cls);

    // Visual connectivity: every input node must touch ≥ 1 live
    // member after pruning. After the repair step above this is
    // almost always true; if it still isn't (e.g. a node has no
    // incident edges at all, which would mean K_n wasn't built),
    // we downrank the snapshot but do NOT reject — the user wants
    // every attempt's result to be visible.
    const conn = new Set<number>();
    for (const m of state.members) {
      conn.add(m.node_a);
      conn.add(m.node_b);
    }
    const allConn = state.nodes.every((nd) => conn.has(nd.node_id));
    if (!allConn) {
      logEvent(state, {
        kind: 'info',
        message:
          `Pruned structure leaves some nodes isolated even after repair; ` +
          `keeping the snapshot anyway so every input point stays visible`,
      });
    }

    // V3/V4 rigidity validation on the pruned structure.
    const rig = validateRigidity(state);
    const rigid = rig.infinitesimallyRigid || rig.prestressStable;
    logEvent(state, {
      kind: rigid ? 'info' : 'failure',
      message:
        `V3 rigidity: rank=${rig.rank}/${3 * state.nodes.length - 6}, ` +
        `mech=${rig.dimMechanism}, dim W=${rig.dimW}, ` +
        `infRigid=${rig.infinitesimallyRigid}, prestressStable=${rig.prestressStable}`,
    });
    const sign = validateSignConsistency(state);
    const class1 = validateMatching(state);
    const prestress = validatePrestressStability(state);
    logEvent(state, {
      kind: prestress.ok ? 'info' : 'failure',
      message:
        `V4 prestress: minEig(Ω)=${prestress.minEig.toExponential(2)} ` +
        `(${prestress.ok ? 'OK' : 'FAIL'})`,
    });

    const success = rigid && class1 && sign.ok && prestress.ok;
    bestHolder = updateBest(
      bestHolder,
      snapshotBest(state, lp.residual, success, rigid),
    );

    if (success) {
      logEvent(state, {
        kind: 'success',
        message:
          `Class-1 tensegrity found: ${cls.strutIds.length} struts, ` +
          `${cls.cableIds.length} cables, ${cls.zeroIds.length} zero-force pruned ` +
          `(${cand.source} matching)`,
        matching_ids: [...cls.strutIds],
      });
      await yieldFn('Phase 3 · success');
      return finalize(state, bestHolder, stats, n, startedAt, false);
    }
  }

  // Loop exhausted (or timed out) without a clean win; return the
  // best-so-far snapshot. We restore structural fields from `best`
  // but PRESERVE the running events log on the live state so the
  // UI sees every iteration's progress, not just the iteration the
  // best snapshot was taken on.
  const timedOut = Date.now() >= deadline;
  if (bestHolder) {
    restoreState(state, bestHolder.state, /* preserveEvents */ true);
  } else {
    assignForceDensities(state);
  }
  return finalize(state, bestHolder, stats, n, startedAt, timedOut);
}

/**
 * Replace the contents of `target` with a deep copy of `source`,
 * mutating in place so any external `() => state` getter observes
 * the change. Used to snap the live state back to the pristine K_n
 * background between matching attempts and to commit the best
 * snapshot at the end of the search.
 */
function restoreState(
  target: MorphogenesisState,
  source: MorphogenesisState,
  preserveEvents: boolean = false,
): void {
  const savedEvents = preserveEvents ? target.events : null;
  const savedNextEventId = preserveEvents ? target.nextEventId : null;
  const fresh = deepCloneState(source);
  // Field-by-field assignment so we keep the same object identity.
  target.nodes = fresh.nodes;
  target.members = fresh.members;
  target.cells = fresh.cells;
  target.cellMembers = fresh.cellMembers;
  target.cellAdjacency = fresh.cellAdjacency;
  target.selfStressStates = fresh.selfStressStates;
  target.selfStressEntries = fresh.selfStressEntries;
  target.morphogenesisSteps = fresh.morphogenesisSteps;
  target.removedMembers = fresh.removedMembers;
  target.events = savedEvents ?? fresh.events;
  target.alpha = fresh.alpha;
  target.matching = fresh.matching;
  target.inputNodeIds = fresh.inputNodeIds;
  target.nextNodeId = fresh.nextNodeId;
  target.nextMemberId = fresh.nextMemberId;
  target.nextCellId = fresh.nextCellId;
  target.nextStateId = fresh.nextStateId;
  target.nextStepId = fresh.nextStepId;
  target.nextEventId = savedNextEventId ?? fresh.nextEventId;
}

function finalize(
  state: MorphogenesisState,
  best: BestResult | null,
  stats: SearchStats,
  n: number,
  startedAt: number,
  timedOut: boolean,
): Class1SearchResult {
  const struts = state.members.filter((m) => m.type === 'strut');
  const strutCount = new Map<number, number>();
  for (const m of struts) {
    strutCount.set(m.node_a, (strutCount.get(m.node_a) ?? 0) + 1);
    strutCount.set(m.node_b, (strutCount.get(m.node_b) ?? 0) + 1);
  }
  let classK = 0;
  for (const c of strutCount.values()) if (c > classK) classK = c;

  const connected = new Set<number>();
  for (const m of state.members) {
    if (m.type === 'candidate') continue;
    connected.add(m.node_a);
    connected.add(m.node_b);
  }
  const allConnected =
    state.nodes.length > 0 && state.nodes.every((nd) => connected.has(nd.node_id));

  const rig = validateRigidity(state);
  const rigid = rig.infinitesimallyRigid || rig.prestressStable;
  const class1 = validateMatching(state);
  const sign = validateSignConsistency(state);
  const success = rigid && class1 && sign.ok && struts.length > 0;

  return {
    state,
    success,
    rigid,
    class1,
    numPoints: n,
    bestClassK: classK,
    allConnected,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    searchStats: stats,
    bestResultNote: best
      ? describeBest(best)
      : success
        ? 'Class-1 tensegrity found'
        : 'no candidate matching produced a valid structure',
  };
}

// ─── Triplex preset entry ──────────────────────────────────
//
// The old version of this function hand-replayed a K₅ adhesion +
// fusion sequence to build the Triplex from 6 canonical points. The
// K_n algorithm finds the Triplex natively from the same 6 points,
// so the preset just delegates to `searchClass1Tensegrity` with
// `points` supplied — there is no longer any need for a separate
// hand-crafted construction.

export async function buildTriplexManually(
  points: Vec3[],
  options: Class1SearchOptions = {},
): Promise<Class1SearchResult> {
  return searchClass1Tensegrity(points.length, points, undefined, options);
}

// ─── Tiny helpers ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
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
        for (let d = c + 1; d < n; d++) out.push([a, b, c, d]);
  return out;
}

function sampleCombinations4(
  n: number,
  k: number,
  rng: () => number,
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < k; i++) {
    const a = Math.floor(rng() * n);
    let b = Math.floor(rng() * n);
    while (b === a) b = Math.floor(rng() * n);
    let c = Math.floor(rng() * n);
    while (c === a || c === b) c = Math.floor(rng() * n);
    let d = Math.floor(rng() * n);
    while (d === a || d === b || d === c) d = Math.floor(rng() * n);
    out.push([a, b, c, d]);
  }
  return out;
}
