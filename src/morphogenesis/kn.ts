/**
 * K_n-based Class-1 tensegrity search primitives.
 *
 * This module implements the algorithmic core of the
 * "K_n null space + strut-only LP" approach:
 *
 *   1. Build the complete graph K_n on n input points as an ordinary
 *      MorphogenesisState (NODE + MEMBER tables, all members start as
 *      'candidate').
 *   2. Compute the full self-stress space W = null(A) of K_n, where A
 *      is the n-point equilibrium matrix. dim(W) = C(n,2) - (3n-6) in
 *      general position.
 *   3. After the LP solves for α, classify every K_n edge by the sign
 *      of (W·α)_e into strut / cable / zero-force. Zero-force edges
 *      are *removed* from the final structure; that pruning is what
 *      recovers a genuine tensegrity (Triplex, n-prism, icosahedron)
 *      from the dense K_n background.
 *
 * The new algorithm has no K₅ covers, no adhesion, no fusion — the
 * single LP call directly probes the complete self-stress space that
 * was previously approximated by a sequence of incremental
 * adhesion/fusion operations. See the design note in the spec for the
 * motivation: strut-only constraints + the full K_n null space make
 * the LP feasible on every known tensegrity (Triplex, 4-prism,
 * 5-prism, tensegrity icosahedron, 3-stage Snelson tower).
 */

import { MorphogenesisState, Vec3, MemberRow } from './types';
import {
  buildEquilibriumMatrix,
  nullspace,
} from './linalg';

/**
 * Minimum separation of W[e,j] from zero below which (Wα)_e is
 * regarded as "zero-force". The default matches the ε used by
 * lpStrutOnly so the classifier and the solver agree on the
 * boundary.
 */
export const DEFAULT_SIGN_EPS = 1e-6;

/**
 * Populate an empty state with the n nodes and C(n,2) K_n members.
 * Returns the dense |E|×dim(W) W matrix, a member_id → row index
 * map, and the edge lengths used to build A.
 *
 * All members are created as 'candidate' — the LP will assign
 * strut/cable types after it solves.
 */
export function buildKnStructure(
  state: MorphogenesisState,
  P: Vec3[],
): {
  W: number[][];
  memberIdx: Map<number, number>;
  lengths: number[];
  dimW: number;
} {
  // ── Nodes ────────────────────────────────────────────────
  state.nodes = [];
  state.members = [];
  state.selfStressStates = [];
  state.selfStressEntries = [];
  state.nextNodeId = 0;
  state.nextMemberId = 0;
  state.nextStateId = 0;

  const nodeIds: number[] = [];
  for (const p of P) {
    const id = state.nextNodeId++;
    state.nodes.push({ node_id: id, x: p[0], y: p[1], z: p[2] });
    nodeIds.push(id);
  }
  // Record the input-node set so downstream code still has access
  // to it (the old algorithm used this to restrict adhesion targets;
  // here it is simply the full node list).
  state.inputNodeIds = new Set(nodeIds);

  // ── K_n members ──────────────────────────────────────────
  const n = nodeIds.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const mid = state.nextMemberId++;
      state.members.push({
        member_id: mid,
        node_a: nodeIds[i],
        node_b: nodeIds[j],
        type: 'candidate',
        force_density: null,
      });
    }
  }

  // ── W = nullspace(A) ─────────────────────────────────────
  const { A, lengths } = buildEquilibriumMatrix(state.nodes, state.members);
  const basis = nullspace(A); // basis is a list of |E|-length column vectors

  // Dense |E| × k W matrix.
  const E = state.members.length;
  const dimW = basis.length;
  const W: number[][] = Array.from({ length: E }, () => new Array(dimW).fill(0));
  for (let j = 0; j < dimW; j++) {
    const col = basis[j];
    for (let e = 0; e < E; e++) W[e][j] = col[e];
  }

  // memberIdx: row-index in W (same as insertion order).
  const memberIdx = new Map<number, number>();
  state.members.forEach((m, i) => memberIdx.set(m.member_id, i));

  // Populate the SELF_STRESS_STATE / SELF_STRESS_ENTRY tables so
  // the UI still shows a non-empty W basis in the inspector panels.
  // Each column of W becomes one state row; non-zero entries become
  // sparse-entry rows. This is purely for display — the search
  // itself operates on the dense W matrix returned here.
  for (let j = 0; j < dimW; j++) {
    const stateId = state.nextStateId++;
    state.selfStressStates.push({ state_id: stateId, cell_id: null });
    for (let e = 0; e < E; e++) {
      const v = W[e][j];
      if (Math.abs(v) > 1e-14) {
        state.selfStressEntries.push({
          state_id: stateId,
          member_id: state.members[e].member_id,
          w_value: v,
        });
      }
    }
  }

  return { W, memberIdx, lengths, dimW };
}

/**
 * Compute w* = W·α for every K_n member. Returns a flat |E|-vector
 * aligned with the row index of W.
 */
export function computeWAlpha(W: number[][], alpha: number[]): number[] {
  const E = W.length;
  if (E === 0) return [];
  const k = W[0].length;
  const out = new Array(E).fill(0);
  for (let e = 0; e < E; e++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += W[e][j] * alpha[j];
    out[e] = s;
  }
  return out;
}

/**
 * Classify every K_n edge by the sign of (Wα)_e:
 *
 *   strut  ← (Wα)_e < -signEps
 *   cable  ← (Wα)_e > +signEps
 *   zero   ← |(Wα)_e| ≤ signEps  (removed from the final structure)
 *
 * `signEps` is chosen adaptively as max(1e-4, 0.01 · max|Wα|) so it
 * scales with the problem size; the caller may override it by passing
 * an explicit value.
 *
 * Returns the lists of member_ids in each category along with the
 * per-edge w* values so callers can assign force densities.
 */
export function classifyKnEdges(
  members: MemberRow[],
  wStar: number[],
  memberIdx: Map<number, number>,
  signEpsOverride?: number,
): {
  strutIds: number[];
  cableIds: number[];
  zeroIds: number[];
  signEps: number;
  maxAbs: number;
} {
  // Compute max|w*| and normalise once so the threshold is a
  // RELATIVE fraction of peak force. Without this, an unconstrained
  // LP can return α with arbitrarily large magnitude (the strut-
  // only objective has no upper bound on |α|), which would inflate
  // an absolute threshold past every legitimate cable.
  let maxAbs = 0;
  for (const v of wStar) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 1e-18) {
    // Degenerate α ≈ 0: every member is "zero-force" by definition.
    return {
      strutIds: [],
      cableIds: [],
      zeroIds: members.map((m) => m.member_id),
      signEps: 0,
      maxAbs: 0,
    };
  }
  // Default threshold: 1% of peak force. Members whose normalised
  // |w*/max| is below this are zero-force noise; everything else is
  // signal. The override path lets callers tune the cut-off if a
  // particular structure has unusually fine-grained signal.
  const signEps = signEpsOverride ?? 1e-2;

  const strutIds: number[] = [];
  const cableIds: number[] = [];
  const zeroIds: number[] = [];
  for (const m of members) {
    const row = memberIdx.get(m.member_id);
    if (row === undefined) continue;
    const vNorm = wStar[row] / maxAbs;
    if (vNorm < -signEps) strutIds.push(m.member_id);
    else if (vNorm > +signEps) cableIds.push(m.member_id);
    else zeroIds.push(m.member_id);
  }
  return { strutIds, cableIds, zeroIds, signEps, maxAbs };
}

/**
 * Apply a classification to the state's MEMBER table: strut/cable
 * members keep their row and receive a force_density, zero-force
 * members are DELETED from `state.members` (the tensegrity does not
 * include them). Callers must already have computed `wStar` via
 * `computeWAlpha`.
 *
 * Returns the new list of live members (after zero-force removal)
 * for downstream rigidity validation.
 */
export function applyClassificationAndPrune(
  state: MorphogenesisState,
  wStar: number[],
  memberIdx: Map<number, number>,
  classification: { strutIds: number[]; cableIds: number[]; zeroIds: number[] },
): MemberRow[] {
  const zeroSet = new Set(classification.zeroIds);
  const strutSet = new Set(classification.strutIds);
  const cableSet = new Set(classification.cableIds);

  const newMembers: MemberRow[] = [];
  for (const m of state.members) {
    if (zeroSet.has(m.member_id)) continue;
    const row = memberIdx.get(m.member_id);
    const q = row !== undefined ? wStar[row] : 0;
    m.force_density = q;
    if (strutSet.has(m.member_id)) m.type = 'strut';
    else if (cableSet.has(m.member_id)) m.type = 'cable';
    else m.type = 'candidate';
    newMembers.push(m);
  }
  state.members = newMembers;
  return newMembers;
}

// ── Matching enumeration ─────────────────────────────────────

/**
 * A single strutness-priority candidate matching. The caller
 * consumes these one at a time and runs lpStrutOnly on each.
 */
export interface MatchingCandidate {
  ids: number[];
  source: string;
}

/**
 * Build a pool of candidate maximum matchings for the LP to try.
 *
 * The pool combines several orthogonal priorities:
 *
 *   1. "strutness": the most negative W entry per edge. Edges that
 *      any basis direction wants to push into compression are
 *      prioritised.
 *   2. "length": raw Euclidean edge length. Long edges are natural
 *      strut candidates in most tensegrities.
 *   3. "-length": the reverse — useful for structures where the
 *      struts are shorter than some cables (rare but possible).
 *   4. Random matchings with a deterministic seed, so failures are
 *      reproducible and the budget controls how hard we try.
 *
 * Duplicates (same edge-id set) are filtered out so the LP is never
 * invoked twice on the same matching.
 */
export function generateMatchingCandidates(
  state: MorphogenesisState,
  W: number[][],
  memberIdx: Map<number, number>,
  options: {
    randomCount?: number;
    seed?: number;
  } = {},
): MatchingCandidate[] {
  const randomCount = options.randomCount ?? 20;
  const seed = options.seed ?? 1;

  if (state.members.length === 0) return [];

  const edges = state.members.map((m) => ({
    id: m.member_id,
    node_a: m.node_a,
    node_b: m.node_b,
  }));

  // ── Positions & priorities ──────────────────────────────
  const posById = new Map<number, { x: number; y: number; z: number }>();
  for (const nd of state.nodes) {
    posById.set(nd.node_id, { x: nd.x, y: nd.y, z: nd.z });
  }
  const edgeLength = (e: { node_a: number; node_b: number }): number => {
    const a = posById.get(e.node_a);
    const b = posById.get(e.node_b);
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  };
  const strutnessScore = (e: { id: number }): number => {
    const i = memberIdx.get(e.id);
    if (i === undefined) return 0;
    let mn = 0;
    for (let j = 0; j < W[i].length; j++) {
      if (W[i][j] < mn) mn = W[i][j];
    }
    return -mn;
  };
  const spanning = (e: { node_a: number; node_b: number }): number => {
    const a = posById.get(e.node_a);
    const b = posById.get(e.node_b);
    if (!a || !b) return 0;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    const dz = Math.abs(a.z - b.z);
    const len = Math.hypot(dx, dy, dz);
    return len * Math.max(dx, dy, dz);
  };

  const out: MatchingCandidate[] = [];
  const seen = new Set<string>();
  const sigOf = (ids: number[]) =>
    ids.slice().sort((a, b) => a - b).join(',');
  const addIfNew = (ids: number[], source: string) => {
    if (ids.length === 0) return;
    const s = sigOf(ids);
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ ids, source });
  };

  // Import maximumMatching lazily so kn.ts stays decoupled from the
  // matching module's internal state (the UI has no dependency on
  // Edmonds' algorithm and we want kn.ts to remain a leaf module).
  // But we're OK with a normal import at the top — deferred loading
  // would break tree-shaking. Keep the call-site local.
  //
  // (Actual import is at file top.)

  addIfNew(maxMatch(edges, strutnessScore), 'strutness');
  addIfNew(maxMatch(edges, edgeLength), 'length');
  addIfNew(maxMatch(edges, (e) => -edgeLength(e)), 'short');
  addIfNew(maxMatch(edges, spanning), 'spanning');
  addIfNew(
    maxMatch(edges, (e) => edgeLength(e) * strutnessScore(e)),
    'len·strut',
  );

  // Random matchings (deterministic seed via mulberry32).
  let rng = mulberry32(seed);
  for (let r = 0; r < randomCount; r++) {
    const randPri = (): number => rng() * 2 - 1;
    addIfNew(maxMatch(edges, randPri), `random#${r}`);
  }

  return out;
}

// ── Local helpers ────────────────────────────────────────────

// `maxMatch` is a thin shim re-exporting the matching module's
// `maximumMatching`. Declared as a local re-export so the top of
// `kn.ts` can keep all imports together.
import { maximumMatching, Edge as _Edge } from './matching';
function maxMatch(
  edges: _Edge[],
  priority: (e: _Edge) => number,
): number[] {
  return maximumMatching(edges, priority);
}

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
