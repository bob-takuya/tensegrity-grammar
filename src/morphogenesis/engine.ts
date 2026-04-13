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
import { adhereCell, suggestNewPositions, predictDeltaW } from './adhesion';
import { fuseOneEdge } from './fusion';
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
    nextNodeId: 0,
    nextMemberId: 0,
    nextCellId: 0,
    nextStateId: 0,
    nextStepId: 0,
  };
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

  return cell;
}

// ─── Force density synthesis ────────────────────────────────────

/**
 * Once W has been populated, every member inherits a force density
 * read off from the first basis column (Section 3 of the paper). This
 * is what downstream visualisation / constraint checks consume.
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
  // into MEMBER.force_density without re-dividing by L.
  for (let i = 0; i < m; i++) {
    const mem = state.members[i];
    mem.force_density = w[i];
    if (mem.type === 'candidate') {
      mem.type = w[i] > 0 ? 'cable' : 'strut';
    }
  }
}

function memberLength(state: MorphogenesisState, mem: MemberRow): number {
  const a = state.nodes.find(n => n.node_id === mem.node_a);
  const b = state.nodes.find(n => n.node_id === mem.node_b);
  if (!a || !b) return 1;
  return vdist([a.x, a.y, a.z], [b.x, b.y, b.z]);
}

// ─── AutoGrow ───────────────────────────────────────────────────

export interface AutoGrowOptions {
  spread?: number;
  adhesionAttempts?: number;
  fuseProbability?: number;
  maxCompDeg?: number;
}

/**
 * Build a multi-cell structure by seeding with a K₅ and repeatedly
 * attaching new K₅s (adhesion). Optionally fuses a fraction of the
 * least-stressed members at the end. All steps are recorded in
 * MORPHOGENESIS_STEP so the UI can play them back.
 */
export function autoGrow(
  state: MorphogenesisState,
  numCells: number,
  options: AutoGrowOptions = {},
): boolean {
  const {
    spread = 0.3,
    adhesionAttempts = 12,
    fuseProbability = 0,
    maxCompDeg = 1,
  } = options;

  // Seed
  const seedPts: Vec3[] = [
    [ 1.0,  0.0,  0.0],
    [-0.5,  0.866,  0.2],
    [-0.5, -0.866,  0.1],
    [ 0.2,  0.1,  1.2],
    [ 0.0,  0.0, -0.9],
  ].map(p => [
    p[0] + (Math.random() - 0.5) * spread,
    p[1] + (Math.random() - 0.5) * spread,
    p[2] + (Math.random() - 0.5) * spread,
  ] as Vec3);
  const seed = initializeK5(state, seedPts);
  if (!seed) return false;

  // Adhesion loop
  for (let step = 1; step < numCells; step++) {
    let placed = false;
    for (let attempt = 0; attempt < adhesionAttempts && !placed; attempt++) {
      const sharedCount = Math.random() < 0.5 ? 3 : 4;
      if (state.nodes.length < sharedCount) break;

      // Pick a seed node and take its nearest neighbours as the shared face.
      const seedIdx = Math.floor(Math.random() * state.nodes.length);
      const seedNode = state.nodes[seedIdx];
      const seedPos: Vec3 = [seedNode.x, seedNode.y, seedNode.z];
      const ranked = state.nodes
        .map(n => ({ id: n.node_id, d: vdist(seedPos, [n.x, n.y, n.z]) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, Math.min(state.nodes.length, sharedCount * 2));
      const shuffled = [...ranked].sort(() => Math.random() - 0.5);
      const sharedIds = shuffled.slice(0, sharedCount).map(x => x.id);

      const positions = suggestNewPositions(state, sharedIds, 1.4);
      const res = adhereCell(state, sharedIds, positions);
      if (res) placed = true;
    }
    if (!placed) break;
  }

  // Optional fusion sweep
  if (fuseProbability > 0) {
    const target = Math.max(
      1,
      Math.floor(state.members.length * fuseProbability * 0.2),
    );
    let removed = 0;
    const order = [...state.members]
      .sort((a, b) => Math.abs(a.force_density ?? 0) - Math.abs(b.force_density ?? 0))
      .map(m => m.member_id);
    for (const mid of order) {
      if (removed >= target) break;
      if (fuseOneEdge(state, mid)) removed++;
    }
  }

  assignForceDensities(state);
  enforceClassK(state, maxCompDeg);
  return true;
}

/**
 * Flip signs of unassigned cells' self-stress contributions when the
 * global w* puts too many struts on a single node. This is a shallow
 * heuristic — the paper itself does not define Class-k — but it keeps
 * the UI visualisation close to the canonical Class-1 tensegrity.
 */
function enforceClassK(state: MorphogenesisState, maxCompDeg: number): void {
  if (!Number.isFinite(maxCompDeg) || maxCompDeg >= 6) return;
  // A single global sign flip is the only operation that commutes with
  // the full nullspace basis; flip if it reduces the worst-case strut
  // degree.
  const strutDeg = (signFlip: boolean) => {
    const count = new Map<number, number>();
    for (const m of state.members) {
      const q = (m.force_density ?? 0) * (signFlip ? -1 : 1);
      if (q >= 0) continue;
      count.set(m.node_a, (count.get(m.node_a) || 0) + 1);
      count.set(m.node_b, (count.get(m.node_b) || 0) + 1);
    }
    let worst = 0;
    for (const v of count.values()) if (v > worst) worst = v;
    return worst;
  };

  if (strutDeg(true) < strutDeg(false)) {
    for (const m of state.members) {
      if (m.force_density != null) m.force_density = -m.force_density;
      if (m.type === 'cable') m.type = 'strut';
      else if (m.type === 'strut') m.type = 'cable';
    }
  }
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
