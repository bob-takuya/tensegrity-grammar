/**
 * Adhesion phase + virtual-cell search.
 *
 * Adhesion attaches a fresh K₅ cell to the current structure via 3 or
 * 4 shared nodes. By the paper's Corollary the increase in dim W for
 * a step that adds Δe members and Δv nodes is e_i − 3 v_i, which the
 * engine uses to decide how many extra "virtual" self-stress states
 * are expected beyond the one contributed directly by the new cell.
 *
 * When predict_delta_W > 1 we need to find those extra states. The
 * spec gives a constructive procedure (SUB: FIND_VIRTUAL_CELLS): tear
 * one "own" edge from each existing regular cell, then search for
 * additional sub-graphs whose own null space contributes a new state.
 */

import {
  MorphogenesisState, Vec3, NodeRow, MemberRow, CellRow,
} from './types';
import { cellSelfStress } from './k5cell';
import { buildEquilibriumMatrix, nullspace } from './linalg';
import { vdist } from './geometry';

// ─── F2.5 — predict_delta_W(Δe, Δv) ─────────────────────────────

/**
 * Corollary of Maxwell's rule: for a self-stressed step that adds Δe
 * members and Δv nodes, dim W increases by exactly Δe − 3 Δv.
 */
export function predictDeltaW(deltaE: number, deltaV: number): number {
  return deltaE - 3 * deltaV;
}

// ─── Low-level state helpers ─────────────────────────────────────

function nodePos(state: MorphogenesisState, id: number): Vec3 {
  const n = state.nodes.find(nd => nd.node_id === id)!;
  return [n.x, n.y, n.z];
}

function findMember(
  state: MorphogenesisState,
  a: number, b: number,
): MemberRow | undefined {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return state.members.find(m => m.node_a === lo && m.node_b === hi);
}

function addNode(state: MorphogenesisState, p: Vec3): number {
  const id = state.nextNodeId++;
  state.nodes.push({ node_id: id, x: p[0], y: p[1], z: p[2] });
  return id;
}

function addMember(
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

// ─── K₅ adhesion ────────────────────────────────────────────────

export interface AdhesionResult {
  cellId: number;
  addedNodeIds: number[];
  addedMemberIds: number[];
  predictedDeltaW: number;
  actualDeltaW: number;
}

/**
 * Perform one adhesion step.
 *
 *   1. Instantiate the 5 node_ids of the new K₅ (3 or 4 shared).
 *   2. Add the missing K₅ members to G.E.
 *   3. Record the CELL row, CELL_MEMBER links, and CELL_ADJACENCY
 *      with every previously existing cell that shares members.
 *   4. Compute cell_self_stress() for the new K₅ and append it as a
 *      SELF_STRESS_STATE / SELF_STRESS_ENTRY column.
 *   5. Ask predict_delta_W(); if the predicted gain is larger than 1
 *      (e.g. sharing 4 nodes gains 4 members and 1 node → Δ dim W = 1,
 *      sharing 3 nodes gains 7 members and 2 nodes → Δ dim W = 1 too,
 *      so this branch fires only for coupled topologies), fall back to
 *      findVirtualCells() for the missing columns.
 */
export function adhereCell(
  state: MorphogenesisState,
  sharedIds: number[],
  newPositions: Vec3[],
): AdhesionResult | null {
  if (sharedIds.length < 3 || sharedIds.length > 4) return null;
  if (sharedIds.length + newPositions.length !== 5) return null;
  for (const sid of sharedIds) {
    if (!state.nodes.find(n => n.node_id === sid)) return null;
  }

  const dimBefore = state.selfStressStates.length;

  const stepId = state.nextStepId++;

  // Assemble the 5 node ids of the new K₅
  const addedNodeIds: number[] = [];
  for (const p of newPositions) addedNodeIds.push(addNode(state, p));
  const cellNodeIds = [...sharedIds, ...addedNodeIds];

  // Add missing K₅ members
  const addedMemberIds: number[] = [];
  const cellMemberIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const a = cellNodeIds[i], b = cellNodeIds[j];
      const existing = findMember(state, a, b);
      if (existing) {
        cellMemberIds.push(existing.member_id);
      } else {
        const id = addMember(state, a, b, 'candidate');
        cellMemberIds.push(id);
        addedMemberIds.push(id);
      }
    }
  }

  // CELL / CELL_MEMBER rows
  const cellId = state.nextCellId++;
  const newCell: CellRow = {
    cell_id: cellId,
    cell_type: 'regular',
    step_created: stepId,
    node_ids: cellNodeIds,
  };
  state.cells.push(newCell);
  for (const mid of cellMemberIds) {
    state.cellMembers.push({ cell_id: cellId, member_id: mid });
  }

  // CELL_ADJACENCY rows — shared member sets with every other cell
  for (const prev of state.cells) {
    if (prev.cell_id === cellId) continue;
    const prevMembers = new Set(
      state.cellMembers.filter(cm => cm.cell_id === prev.cell_id).map(cm => cm.member_id),
    );
    const shared = cellMemberIds.filter(mid => prevMembers.has(mid));
    if (shared.length > 0) {
      state.cellAdjacency.push({
        cell_i: prev.cell_id, cell_j: cellId, shared_members: shared,
      });
    }
  }

  // Self-stress of the new cell (Eq.(13) / F2.2)
  const points = cellNodeIds.map(id => nodePos(state, id));
  const w = cellSelfStress(points);
  if (w) {
    const stateId = state.nextStateId++;
    state.selfStressStates.push({ state_id: stateId, cell_id: cellId });
    // Order of cellSelfStress() output matches k5EdgePairs() which in
    // turn matches the i<j ordering we used above.
    let k = 0;
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        const mid = cellMemberIds[k];
        if (Math.abs(w[k]) > 1e-12) {
          state.selfStressEntries.push({
            state_id: stateId, member_id: mid, w_value: w[k],
          });
        }
        k++;
      }
    }
    // Type assignment on the newly added members
    for (let kk = 0; kk < cellMemberIds.length; kk++) {
      const member = state.members.find(m => m.member_id === cellMemberIds[kk]);
      if (member && member.type === 'candidate') {
        member.type = w[kk] > 0 ? 'cable' : 'strut';
        member.force_density = w[kk];
      }
    }
  }

  // Corollary check — are more self-stress states expected?
  const predicted = predictDeltaW(addedMemberIds.length, addedNodeIds.length);
  if (predicted > 1) {
    const missing = predicted - (state.selfStressStates.length - dimBefore);
    if (missing > 0) {
      const extras = findVirtualCells(state, missing);
      for (const w_v of extras) {
        const stateId = state.nextStateId++;
        state.selfStressStates.push({ state_id: stateId, cell_id: null });
        for (let e = 0; e < state.members.length; e++) {
          if (Math.abs(w_v[e]) > 1e-12) {
            state.selfStressEntries.push({
              state_id: stateId,
              member_id: state.members[e].member_id,
              w_value: w_v[e],
            });
          }
        }
      }
    }
  }

  const dimAfter = state.selfStressStates.length;

  state.morphogenesisSteps.push({
    step_id: stepId,
    operation: 'adhesion',
    delta_e: addedMemberIds.length,
    delta_v: addedNodeIds.length,
    delta_dim_W_predicted: predicted,
    delta_dim_W_actual: dimAfter - dimBefore,
  });

  return {
    cellId,
    addedNodeIds,
    addedMemberIds,
    predictedDeltaW: predicted,
    actualDeltaW: dimAfter - dimBefore,
  };
}

// ─── SUB: FIND_VIRTUAL_CELLS ────────────────────────────────────

/**
 * Attempt to exhibit `target` additional self-stress states beyond
 * those carried by the regular cells of Gc. The sketch follows the
 * paper's Section 4:
 *
 *   (i)  strip one own-edge per regular/fused cell to leave s-p dims
 *   (ii) globally re-evaluate the null space; any genuinely new basis
 *        direction (tested via linear independence) becomes a virtual
 *        self-stress state embedded in the full member list.
 *
 * This is intentionally a best-effort routine: the paper proves that
 * the search terminates for the cases it studies, but in general a
 * greedy implementation suffices because any missing state would
 * cause the global nullspace(A) to have more columns than the sum of
 * per-cell contributions.
 */
export function findVirtualCells(
  state: MorphogenesisState,
  target: number,
): number[][] {
  const out: number[][] = [];
  if (target <= 0) return out;

  const { A } = buildEquilibriumMatrix(state.nodes, state.members);
  const basis = nullspace(A);

  const existing = denseBasisMatrix(state);
  for (const candidate of basis) {
    if (!isLinearlyIndependent(candidate, existing)) continue;
    out.push(candidate);
    existing.push(candidate);
    if (out.length >= target) break;
  }
  return out;
}

function denseBasisMatrix(state: MorphogenesisState): number[][] {
  const m = state.members.length;
  const memberIdx = new Map<number, number>();
  state.members.forEach((mem, i) => memberIdx.set(mem.member_id, i));

  const cols: number[][] = [];
  for (const s of state.selfStressStates) {
    const v = new Array(m).fill(0);
    for (const e of state.selfStressEntries) {
      if (e.state_id === s.state_id) {
        const idx = memberIdx.get(e.member_id);
        if (idx !== undefined) v[idx] = e.w_value;
      }
    }
    cols.push(v);
  }
  return cols;
}

function isLinearlyIndependent(v: number[], basis: number[][]): boolean {
  if (basis.length === 0) {
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    return max > 1e-10;
  }
  // Project v onto span(basis) via Gram-Schmidt and measure residual.
  const r = [...v];
  for (const b of basis) {
    let bb = 0, rb = 0;
    for (let i = 0; i < b.length; i++) { bb += b[i] * b[i]; rb += b[i] * r[i]; }
    if (bb < 1e-20) continue;
    const c = rb / bb;
    for (let i = 0; i < b.length; i++) r[i] -= c * b[i];
  }
  let max = 0;
  for (const x of r) max = Math.max(max, Math.abs(x));
  return max > 1e-8;
}

// ─── Position suggestion ───────────────────────────────────────

/**
 * Pick reasonable positions for the `nNew = 5 - sharedIds.length` free
 * nodes of a new K₅: offset above the centroid of the shared face.
 */
export function suggestNewPositions(
  state: MorphogenesisState,
  sharedIds: number[],
  distance: number = 1.5,
  direction?: Vec3,
): Vec3[] {
  const sharedNodes: NodeRow[] = sharedIds.map(
    id => state.nodes.find(n => n.node_id === id)!,
  );
  const nShared = sharedNodes.length;
  const nNew = 5 - nShared;

  const cx = sharedNodes.reduce((s, n) => s + n.x, 0) / nShared;
  const cy = sharedNodes.reduce((s, n) => s + n.y, 0) / nShared;
  const cz = sharedNodes.reduce((s, n) => s + n.z, 0) / nShared;

  let normal: Vec3 = [0, 0, 1];
  if (direction) {
    normal = direction;
  } else if (nShared >= 3) {
    const a: Vec3 = [sharedNodes[0].x, sharedNodes[0].y, sharedNodes[0].z];
    const b: Vec3 = [sharedNodes[1].x, sharedNodes[1].y, sharedNodes[1].z];
    const c: Vec3 = [sharedNodes[2].x, sharedNodes[2].y, sharedNodes[2].z];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr: Vec3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const ln = Math.sqrt(cr[0] ** 2 + cr[1] ** 2 + cr[2] ** 2);
    if (ln > 1e-10) normal = [cr[0] / ln, cr[1] / ln, cr[2] / ln];
  }

  const positions: Vec3[] = [];
  for (let i = 0; i < nNew; i++) {
    const d = distance * (0.8 + Math.random() * 0.4);
    const jx = (Math.random() - 0.5) * distance * 0.5;
    const jy = (Math.random() - 0.5) * distance * 0.5;
    const jz = (Math.random() - 0.5) * distance * 0.5;
    positions.push([
      cx + normal[0] * d + jx,
      cy + normal[1] * d + jy,
      cz + normal[2] * d + jz,
    ]);
  }
  return positions;
}

// Utility used by the engine's initial-cell typing. Exported so tests
// and debug scripts can compute per-member lengths on the new schema.
export function memberLength(state: MorphogenesisState, mem: MemberRow): number {
  const a = state.nodes.find(n => n.node_id === mem.node_a)!;
  const b = state.nodes.find(n => n.node_id === mem.node_b)!;
  return vdist([a.x, a.y, a.z], [b.x, b.y, b.z]);
}
