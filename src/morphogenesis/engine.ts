/**
 * Cellular Morphogenesis Engine — main algorithm.
 *
 *   ALGORITHM: CellularMorphogenesis
 *     INPUT   initial K₅ cell, ordered list of steps (adhesion / fusion)
 *     OUTPUT  structure graph G = (V, E), morphogenesis graph Gc,
 *             self-stress basis W
 *
 * The in-memory representation follows the relational schema defined
 * in types.ts: every entity is a table, every relationship a join.
 * See `adhesion.ts` / `fusion.ts` for the detail of each phase; this
 * file wires them together with the initialisation routine and some
 * convenience entry points for the UI.
 */

import {
  MorphogenesisState, Vec3, NodeRow, MemberRow,
} from './types';
import { buildEquilibriumMatrix, nullspace } from './linalg';
import { vdist } from './geometry';

// ─── State setup ─────────────────────────────────────────────────

export function createEmptyState(): MorphogenesisState {
  return {
    nodes: [],
    members: [],
    cells: [],
    cellMembers: [],
    cellAdjacency: [],
    selfStressStates: [],
    selfStressEntries: [],
    morphogenesisSteps: [],
    removedMembers: [],
    events: [],
    alpha: [],
    matching: [],
    inputNodeIds: new Set<number>(),
    nextNodeId: 0,
    nextMemberId: 0,
    nextCellId: 0,
    nextStateId: 0,
    nextStepId: 0,
    nextEventId: 0,
  };
}

/**
 * Deep-clone a MorphogenesisState so the beam-search driver in
 * `searchClass1.ts` can explore branching fusion decisions
 * independently. Every array is shallow-copied with inner objects
 * cloned via spread — the relational schema has no cyclic
 * references, so one level of object copies is enough to isolate
 * branches. The `inputNodeIds` Set is copied (not shared) so that
 * `addAdhesionForDim` updates on one branch don't leak into
 * siblings.
 */
export function deepCloneState(state: MorphogenesisState): MorphogenesisState {
  return {
    nodes: state.nodes.map(n => ({ ...n })),
    members: state.members.map(m => ({ ...m })),
    cells: state.cells.map(c => ({ ...c, node_ids: [...c.node_ids] })),
    cellMembers: state.cellMembers.map(cm => ({ ...cm })),
    cellAdjacency: state.cellAdjacency.map(a => ({
      ...a,
      shared_members: [...a.shared_members],
    })),
    selfStressStates: state.selfStressStates.map(s => ({ ...s })),
    selfStressEntries: state.selfStressEntries.map(e => ({ ...e })),
    morphogenesisSteps: state.morphogenesisSteps.map(s => ({ ...s })),
    removedMembers: state.removedMembers.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    alpha: [...state.alpha],
    matching: [...state.matching],
    inputNodeIds: new Set(state.inputNodeIds),
    nextNodeId: state.nextNodeId,
    nextMemberId: state.nextMemberId,
    nextCellId: state.nextCellId,
    nextStateId: state.nextStateId,
    nextStepId: state.nextStepId,
    nextEventId: state.nextEventId,
  };
}

/** Append one event to the search trace. */
export function logEvent(
  state: MorphogenesisState,
  ev: Omit<import('./types').SearchEvent, 'event_id'>,
): void {
  state.events.push({ event_id: state.nextEventId++, ...ev });
}

// ─── Force density synthesis ────────────────────────────────────

/**
 * Once W has been populated, every member inherits a force density
 * read off from the first basis column (Section 3 of the paper). This
 * is what downstream visualisation / constraint checks consume.
 *
 * Critically, we always re-derive member TYPE from the sign of the
 * force density we just assigned. The previous implementation only
 * re-typed 'candidate' members, which meant that members typed at
 * init/adhesion time (from their own cell's self-stress) would keep
 * their original type even if the ambient column-0 self-stress
 * assigned them the opposite sign — producing cables with negative
 * force density, which is exactly the regression we're fixing here.
 */
export function assignForceDensities(state: MorphogenesisState): void {
  const m = state.members.length;
  if (m === 0) return;
  const memberIdx = new Map<number, number>();
  state.members.forEach((mem, i) => memberIdx.set(mem.member_id, i));

  // Pick w* = column 0 of W (any non-trivial member of the span works
  // for visualisation). force_density is w* / L.
  const w = new Array(m).fill(0);
  if (state.selfStressStates.length > 0) {
    const s0 = state.selfStressStates[0].state_id;
    for (const e of state.selfStressEntries) {
      if (e.state_id !== s0) continue;
      const idx = memberIdx.get(e.member_id);
      if (idx !== undefined) w[idx] = e.w_value;
    }
  }

  // SELF_STRESS_ENTRY.w_value already stores force densities (q = w/L),
  // computed directly by cellSelfStress() via Eq.(13). Copy straight
  // into MEMBER.force_density without re-dividing by L, then sync the
  // member type with the sign of the assigned density.
  const eps = 1e-10;
  for (let i = 0; i < m; i++) {
    const mem = state.members[i];
    mem.force_density = w[i];
    if (w[i] > eps)       mem.type = 'cable';
    else if (w[i] < -eps) mem.type = 'strut';
    else                  mem.type = 'candidate';
  }
}

export function memberLength(state: MorphogenesisState, mem: MemberRow): number {
  const a = state.nodes.find(n => n.node_id === mem.node_a);
  const b = state.nodes.find(n => n.node_id === mem.node_b);
  if (!a || !b) return 1;
  return vdist([a.x, a.y, a.z], [b.x, b.y, b.z]);
}

// ─── Verification helpers ──────────────────────────────────────

/**
 * Max-norm residual of A · t on the current members, where t is the
 * axial force vector (= w · L). A value close to zero confirms the
 * whole structure is in equilibrium.
 */
export function verifyEquilibrium(state: MorphogenesisState): number {
  const nodeMap = new Map(state.nodes.map(n => [n.node_id, n]));
  let maxRes = 0;
  for (const node of state.nodes) {
    let fx = 0, fy = 0, fz = 0;
    for (const mem of state.members) {
      let other: NodeRow | undefined;
      if (mem.node_a === node.node_id) other = nodeMap.get(mem.node_b);
      else if (mem.node_b === node.node_id) other = nodeMap.get(mem.node_a);
      else continue;
      if (!other) continue;
      const q = mem.force_density ?? 0;
      fx += q * (other.x - node.x);
      fy += q * (other.y - node.y);
      fz += q * (other.z - node.z);
    }
    maxRes = Math.max(maxRes, Math.abs(fx), Math.abs(fy), Math.abs(fz));
  }
  return maxRes;
}

/** Total dimension of W (number of SELF_STRESS_STATE rows). */
export function dimW(state: MorphogenesisState): number {
  return state.selfStressStates.length;
}

/** Invariant check 1: the structure is infinitesimally rigid. */
export function isInfinitesimallyRigid(state: MorphogenesisState): boolean {
  if (state.nodes.length === 0) return false;
  const { A } = buildEquilibriumMatrix(state.nodes, state.members);
  const null_ = nullspace(A);
  // rank(A) = m - dim ker A = 3|V| - 6 in the rigid case
  const rank = state.members.length - null_.length;
  return rank === 3 * state.nodes.length - 6;
}
