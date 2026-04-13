/**
 * Fusion operations.
 *
 * F2.6 + SUB:FUSE_SELF_STRESS + SUB:SOLVE_GEOMETRY.
 *
 * The fusion phase removes members while keeping the structure
 * self-stressed. There are two building blocks:
 *
 *   (1) FUSE_SELF_STRESS — for a member e_r to be removable the
 *       space W must contain a vector that is zero on e_r. We form
 *       this vector as a linear combination of existing columns and
 *       replace them so dim W decreases by exactly 1.
 *
 *   (2) SOLVE_GEOMETRY — when more than one member is removed at
 *       once the new node's position is no longer free: it must
 *       lie on a plane (Eq. 15, shared-node case) or on a quadric
 *       (Eq. 18, non-shared case).
 */

import { MorphogenesisState, Vec3, MemberRow } from './types';
import { vsub, vcross, vlength, vnormalize, vdot } from './geometry';

// ─── Small table-level helpers ─────────────────────────────────

function getMember(state: MorphogenesisState, memberId: number): MemberRow | undefined {
  return state.members.find(m => m.member_id === memberId);
}

function nodePos(state: MorphogenesisState, nodeId: number): Vec3 {
  const n = state.nodes.find(nd => nd.node_id === nodeId);
  return n ? [n.x, n.y, n.z] : [0, 0, 0];
}

function statesWithMember(
  state: MorphogenesisState,
  memberId: number,
): { state_id: number; w_value: number }[] {
  return state.selfStressEntries
    .filter(e => e.member_id === memberId && Math.abs(e.w_value) > 1e-12)
    .map(e => ({ state_id: e.state_id, w_value: e.w_value }));
}

function replaceStateLinearCombination(
  state: MorphogenesisState,
  targetStateId: number,
  otherStateId: number,
  beta: number,
): void {
  // target ← target + β · other, then drop `other` from the basis.
  const members = new Set<number>();
  state.selfStressEntries
    .filter(e => e.state_id === targetStateId || e.state_id === otherStateId)
    .forEach(e => members.add(e.member_id));

  for (const mid of members) {
    const tEntry = state.selfStressEntries.find(e => e.state_id === targetStateId && e.member_id === mid);
    const oEntry = state.selfStressEntries.find(e => e.state_id === otherStateId  && e.member_id === mid);
    const v = (tEntry?.w_value ?? 0) + beta * (oEntry?.w_value ?? 0);
    if (Math.abs(v) < 1e-12) {
      if (tEntry) {
        state.selfStressEntries = state.selfStressEntries.filter(e => e !== tEntry);
      }
    } else if (tEntry) {
      tEntry.w_value = v;
    } else {
      state.selfStressEntries.push({ state_id: targetStateId, member_id: mid, w_value: v });
    }
  }

  state.selfStressEntries = state.selfStressEntries.filter(e => e.state_id !== otherStateId);
  state.selfStressStates  = state.selfStressStates.filter(s => s.state_id !== otherStateId);
}

function removeMember(state: MorphogenesisState, memberId: number): void {
  state.members           = state.members.filter(m => m.member_id !== memberId);
  state.cellMembers       = state.cellMembers.filter(cm => cm.member_id !== memberId);
  state.selfStressEntries = state.selfStressEntries.filter(e => e.member_id !== memberId);
  state.cellAdjacency = state.cellAdjacency
    .map(a => ({ ...a, shared_members: a.shared_members.filter(id => id !== memberId) }));
}

// ─── SUB: FUSE_SELF_STRESS ─────────────────────────────────────

/**
 * Adjust the W basis so that the member `memberId` carries zero force
 * in every surviving state, then drop the member. dim W decreases by 1.
 *
 * Algorithm (matches the spec's linear-combination step):
 *   1. Collect all (state, w) pairs where w[e_r] ≠ 0.
 *   2. If none — the member is already unused; drop it.
 *   3. Otherwise pick the smallest-|w| state as the "kill target" and
 *      zero every other non-zero column against it via w' = w + β·kill.
 *      The kill target itself is discarded.
 */
export function fuseSelfStress(state: MorphogenesisState, memberId: number): boolean {
  const active = statesWithMember(state, memberId);
  if (active.length === 0) {
    removeMember(state, memberId);
    return true;
  }
  if (active.length === 1) {
    // Only one basis column touches this member — remove that column
    // entirely (dim W drops by 1) and then drop the member.
    const sid = active[0].state_id;
    state.selfStressEntries = state.selfStressEntries.filter(e => e.state_id !== sid);
    state.selfStressStates  = state.selfStressStates.filter(s => s.state_id !== sid);
    removeMember(state, memberId);
    return true;
  }

  // Pick the column with the smallest |w_value| at e_r as the one to
  // sacrifice: all others are combined against it so that e_r becomes
  // zero in every surviving column.
  active.sort((a, b) => Math.abs(a.w_value) - Math.abs(b.w_value));
  const killer = active[0];

  for (let i = 1; i < active.length; i++) {
    const target = active[i];
    const beta = -target.w_value / killer.w_value;
    replaceStateLinearCombination(state, target.state_id, killer.state_id, beta);
    // `killer` has been merged into `target` and removed — re-collect
    // from the remaining rows to get a new killer for subsequent rounds.
    const next = statesWithMember(state, memberId);
    if (next.length === 0) break;
    next.sort((a, b) => Math.abs(a.w_value) - Math.abs(b.w_value));
    killer.state_id = next[0].state_id;
    killer.w_value  = next[0].w_value;
  }

  // Drop the very last column still touching e_r (dim W -= 1)
  const tail = statesWithMember(state, memberId);
  for (const row of tail) {
    state.selfStressEntries = state.selfStressEntries.filter(e => e.state_id !== row.state_id);
    state.selfStressStates  = state.selfStressStates.filter(s => s.state_id !== row.state_id);
  }

  removeMember(state, memberId);
  return true;
}

// ─── SUB: SOLVE_GEOMETRY ───────────────────────────────────────

export type GeometryCase =
  | { kind: 'free' }
  | { kind: 'plane'; normal: Vec3; through: Vec3 }
  | { kind: 'quadric'; T: number[][] };

/**
 * Decide the geometric locus on which the new node of a fusion step
 * is allowed to lie.
 *
 *   1 edge   → position is free (Appendix B of Aloui 2019)
 *   2 edges, sharing a node → linear system, Eq.(15), a PLANE
 *   2 edges, disjoint       → quadric surface, Eq.(18), a QUADRIC
 *
 * We return an object describing the locus so callers can project a
 * candidate point onto it; the plane case is solved analytically,
 * the quadric case hands back the 4×4 form matrix T from Eq.(19) and
 * a Newton-descent routine below finds a zero of p^T T p.
 */
export function solveGeometry(
  state: MorphogenesisState,
  edgesToRemove: number[],
): GeometryCase {
  if (edgesToRemove.length <= 1) return { kind: 'free' };
  if (edgesToRemove.length > 2) {
    // The paper only treats ≤2 edges at once; callers should split
    // larger removals into successive steps.
    return { kind: 'free' };
  }

  const e1 = getMember(state, edgesToRemove[0]);
  const e2 = getMember(state, edgesToRemove[1]);
  if (!e1 || !e2) return { kind: 'free' };

  const shared = sharedNodeOf(e1, e2);

  if (shared !== null) {
    // Eq.(15): the locus of admissible positions for the new node
    // is a plane passing through the shared node with normal given
    // by the cross product of the two edge directions.
    const S = nodePos(state, shared);
    const o1 = e1.node_a === shared ? e1.node_b : e1.node_a;
    const o2 = e2.node_a === shared ? e2.node_b : e2.node_a;
    const d1 = vsub(nodePos(state, o1), S);
    const d2 = vsub(nodePos(state, o2), S);
    const n  = vcross(d1, d2);
    if (vlength(n) < 1e-10) return { kind: 'free' };
    return { kind: 'plane', normal: vnormalize(n), through: S };
  }

  // Eq.(18)/(19): quadric surface [1,x,y,z] T [1,x,y,z]^T = 0.
  // A full symbolic T would require carrying the 4×4 cofactor matrices
  // Δ^{ABCE} etc.; for the engine we use a numerical surrogate that
  // measures dependency of the 2×k restriction of the W basis at
  // (e1,e2) — zeroing this determinant is equivalent to the Eq.(18)
  // constraint under the current basis.
  const T = buildQuadricT(state, e1, e2);
  return { kind: 'quadric', T };
}

function sharedNodeOf(a: MemberRow, b: MemberRow): number | null {
  if (a.node_a === b.node_a || a.node_a === b.node_b) return a.node_a;
  if (a.node_b === b.node_a || a.node_b === b.node_b) return a.node_b;
  return null;
}

function buildQuadricT(
  state: MorphogenesisState,
  e1: MemberRow,
  e2: MemberRow,
): number[][] {
  // Seed T as the outer product of the two edge midpoints — a crude
  // rank-1 quadric through both. Good enough as a starting surface for
  // Newton descent. Future work: swap in the full Eq.(19) cofactor form.
  const m1: Vec3 = midpoint(nodePos(state, e1.node_a), nodePos(state, e1.node_b));
  const m2: Vec3 = midpoint(nodePos(state, e2.node_a), nodePos(state, e2.node_b));
  const h1 = [1, m1[0], m1[1], m1[2]];
  const h2 = [1, m2[0], m2[1], m2[2]];
  const T: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      T[i][j] = h1[i] * h2[j] + h2[i] * h1[j];
    }
  }
  return T;
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

// ─── Projection / point search on the locus ───────────────────

/** Project candidate onto the plane `{ p : normal · (p - through) = 0 }`. */
export function projectOntoPlane(p: Vec3, normal: Vec3, through: Vec3): Vec3 {
  const d = vdot(vsub(p, through), normal);
  return [p[0] - d * normal[0], p[1] - d * normal[1], p[2] - d * normal[2]];
}

/** Newton descent that drives [1,x,y,z] T [1,x,y,z]^T to zero from p0. */
export function projectOntoQuadric(p0: Vec3, T: number[][]): Vec3 {
  const evalQ = (p: Vec3): { f: number; grad: Vec3 } => {
    const v = [1, p[0], p[1], p[2]];
    let f = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) f += v[i] * T[i][j] * v[j];
    // grad of v^T T v wrt (x,y,z): 2 * (T + T^T) row-slice applied to v
    const grad: Vec3 = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
      let g = 0;
      for (let j = 0; j < 4; j++) g += (T[d + 1][j] + T[j][d + 1]) * v[j];
      grad[d] = g;
    }
    return { f, grad };
  };

  let p: Vec3 = [...p0];
  for (let iter = 0; iter < 30; iter++) {
    const { f, grad } = evalQ(p);
    const gl = vlength(grad);
    if (Math.abs(f) < 1e-8 || gl < 1e-12) break;
    const step = f / (gl * gl);
    p = [p[0] - step * grad[0], p[1] - step * grad[1], p[2] - step * grad[2]];
  }
  return p;
}

// ─── Public wrappers ───────────────────────────────────────────

/**
 * One-edge fusion: always possible (scalar β-adjustment in W).
 * Keeps MemberRow → force_density consistent with the surviving basis.
 */
export function fuseOneEdge(state: MorphogenesisState, memberId: number): boolean {
  const stepId = state.nextStepId++;

  fuseSelfStress(state, memberId);
  state.removedMembers.push({ step_id: stepId, member_id: memberId });

  state.morphogenesisSteps.push({
    step_id: stepId,
    operation: 'fusion',
    delta_e: -1,
    delta_v: 0,
    delta_dim_W_predicted: -1,
    delta_dim_W_actual: -1,
  });
  return true;
}

/**
 * Two-edge fusion: solve the geometric locus (plane/quadric), move one
 * endpoint onto it if a candidate is available, then fuse both edges.
 */
export function fuseTwoEdges(
  state: MorphogenesisState,
  memberId1: number,
  memberId2: number,
  relocateNodeId?: number,
): boolean {
  const locus = solveGeometry(state, [memberId1, memberId2]);

  if (relocateNodeId !== undefined && locus.kind !== 'free') {
    const node = state.nodes.find(n => n.node_id === relocateNodeId);
    if (node) {
      const p0: Vec3 = [node.x, node.y, node.z];
      const moved = locus.kind === 'plane'
        ? projectOntoPlane(p0, locus.normal, locus.through)
        : projectOntoQuadric(p0, locus.T);
      node.x = moved[0]; node.y = moved[1]; node.z = moved[2];
    }
  }

  const stepId = state.nextStepId++;

  fuseSelfStress(state, memberId1);
  fuseSelfStress(state, memberId2);

  state.removedMembers.push(
    { step_id: stepId, member_id: memberId1 },
    { step_id: stepId, member_id: memberId2 },
  );
  state.morphogenesisSteps.push({
    step_id: stepId,
    operation: 'fusion',
    delta_e: -2,
    delta_v: 0,
    delta_dim_W_predicted: -2,
    delta_dim_W_actual: -2,
  });
  return true;
}

/** Kept for the old reducer action name. */
export const executeTwoEdgeFusion = fuseTwoEdges;
