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
  MorphogenesisState, Vec3, CellRow, MorphogenesisStepRow,
  NodeRow, MemberRow,
} from './types';
import { cellSelfStress, k5EdgePairs } from './k5cell';
import { predictDeltaW } from './adhesion';
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

// ─── Row-level helpers ──────────────────────────────────────────

function addNodeRow(state: MorphogenesisState, p: Vec3): number {
  const id = state.nextNodeId++;
  state.nodes.push({ node_id: id, x: p[0], y: p[1], z: p[2] });
  return id;
}

function addMemberRow(
  state: MorphogenesisState,
  a: number, b: number,
  type: 'strut' | 'cable' | 'candidate',
): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const id = state.nextMemberId++;
  state.members.push({
    member_id: id, node_a: lo, node_b: hi, type, force_density: null,
  });
  return id;
}

// ─── INIT: seed with a K₅ cell ──────────────────────────────────

/**
 * Initialise the state with a single K₅ cell spanning 5 given points.
 * This corresponds to the INIT block of the main algorithm:
 *
 *   G.V  ← initial_cell.nodes
 *   G.E  ← initial_cell.edges
 *   Gc.Vc ← { Cell_0 }
 *   w_1  ← cell_self_stress(Cell_0)
 *   dim_W ← 1
 *   RECORD step(0, adhesion, Δe=10, Δv=5, predict=-5)
 */
export function initializeK5(state: MorphogenesisState, points: Vec3[]): CellRow | null {
  if (points.length !== 5) return null;
  const w = cellSelfStress(points);
  if (!w) return null;

  const stepId = state.nextStepId++;

  const nodeIds: number[] = points.map(p => addNodeRow(state, p));
  const pairs = k5EdgePairs();
  const memberIds: number[] = pairs.map(([i, j]) => {
    const mid = addMemberRow(state, nodeIds[i], nodeIds[j], 'candidate');
    return mid;
  });

  // Type assignment from the sign of the first self-stress
  for (let k = 0; k < 10; k++) {
    const mem = state.members.find(m => m.member_id === memberIds[k])!;
    mem.type = w[k] > 0 ? 'cable' : 'strut';
    mem.force_density = w[k];
  }

  // CELL
  const cellId = state.nextCellId++;
  const cell: CellRow = {
    cell_id: cellId, cell_type: 'regular', step_created: stepId,
    node_ids: nodeIds,
  };
  state.cells.push(cell);
  for (const mid of memberIds) state.cellMembers.push({ cell_id: cellId, member_id: mid });

  // SELF_STRESS_STATE / ENTRY
  const stateId = state.nextStateId++;
  state.selfStressStates.push({ state_id: stateId, cell_id: cellId });
  for (let k = 0; k < 10; k++) {
    if (Math.abs(w[k]) > 1e-12) {
      state.selfStressEntries.push({
        state_id: stateId, member_id: memberIds[k], w_value: w[k],
      });
    }
  }

  // Journal
  const step: MorphogenesisStepRow = {
    step_id: stepId,
    operation: 'init',
    delta_e: 10,
    delta_v: 5,
    delta_dim_W_predicted: predictDeltaW(10, 5),  // -5 for K₅ (Maxwell rule),
    delta_dim_W_actual: 1,                         // Eq.(13) gives 1D nullspace
  };
  state.morphogenesisSteps.push(step);

  logEvent(state, {
    kind: 'init',
    message: `Seeded K₅ cell #${cellId} with 5 nodes, 10 members`,
    cell_id: cellId,
    node_ids: nodeIds,
    member_ids: memberIds,
    dim_W_before: 0,
    dim_W_after: 1,
  });

  return cell;
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
