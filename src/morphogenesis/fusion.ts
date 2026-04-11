/**
 * Fusion: remove edges from the structure while maintaining self-stress.
 *
 * 1-edge fusion is always possible:
 *   Find a linear combination of self-stress basis vectors that
 *   zeros out the target edge's force density, then remove it.
 *
 * 2-edge fusion requires geometric constraints (Phase M3).
 */

import { MorphogenesisState } from './types';

/**
 * Fuse (remove) a single edge.
 *
 * Given the self-stress basis [w₁, w₂, ...], find coefficients
 * α₁, α₂, ... such that Σ αᵢ wᵢ[e] = 0 for the target edge e,
 * while maintaining a non-trivial self-stress.
 *
 * Algorithm:
 *   1. Find two basis vectors w_a, w_b where w_a[e] ≠ 0
 *   2. Set β = -w_a[e] / w_b[e]
 *   3. New stress = w_a + β × w_b (has zero at edge e)
 *   4. Replace w_a and w_b with this new vector in the basis
 *   5. Remove edge e from the graph
 *
 * Returns true if fusion succeeded.
 */
export function fuseOneEdge(state: MorphogenesisState, edgeId: number): boolean {
  const edgeIdx = state.graph.edges.findIndex(e => e.id === edgeId);
  if (edgeIdx === -1) return false;

  // Find the edge's position in each basis vector
  // Basis vectors are indexed by edge ID
  const edgeIdToIdx = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  const eIdx = edgeIdToIdx.get(edgeId);
  if (eIdx === undefined) return false;

  // Find two basis vectors with non-zero value at this edge
  let wa = -1, wb = -1;
  for (let i = 0; i < state.stressBasis.length; i++) {
    if (Math.abs(state.stressBasis[i][eIdx]) > 1e-12) {
      if (wa === -1) wa = i;
      else if (wb === -1) { wb = i; break; }
    }
  }

  if (wa === -1) {
    // No basis vector has non-zero value here — edge already has zero stress
    // Can safely remove
    state.graph.edges.splice(edgeIdx, 1);
    // Remove from any cells that reference it
    for (const cell of state.cells) {
      cell.edgeIds = cell.edgeIds.filter(id => id !== edgeId);
    }
    return true;
  }

  if (wb === -1) {
    // Only one basis vector has non-zero value — removing this edge
    // kills that self-stress state entirely
    // Remove the basis vector
    state.stressBasis.splice(wa, 1);
    state.graph.edges.splice(edgeIdx, 1);
    for (const cell of state.cells) {
      cell.edgeIds = cell.edgeIds.filter(id => id !== edgeId);
    }
    // Rebuild edge index in remaining basis vectors
    rebuildBasisAfterEdgeRemoval(state, edgeIdx);
    return true;
  }

  // Two basis vectors: combine to zero out the target edge
  const valA = state.stressBasis[wa][eIdx];
  const valB = state.stressBasis[wb][eIdx];
  const beta = -valA / valB;

  // New combined vector replaces wa
  const combined = state.stressBasis[wa].map(
    (v, i) => v + beta * state.stressBasis[wb][i]
  );

  // Remove wb from basis (it's been absorbed into the combination)
  state.stressBasis[wa] = combined;
  state.stressBasis.splice(wb, 1);

  // Remove the edge
  state.graph.edges.splice(edgeIdx, 1);
  for (const cell of state.cells) {
    cell.edgeIds = cell.edgeIds.filter(id => id !== edgeId);
  }
  rebuildBasisAfterEdgeRemoval(state, edgeIdx);

  return true;
}

/**
 * After removing an edge at index `removedIdx`, shift all basis
 * vectors to account for the removed column.
 */
function rebuildBasisAfterEdgeRemoval(state: MorphogenesisState, removedIdx: number): void {
  for (let i = 0; i < state.stressBasis.length; i++) {
    state.stressBasis[i].splice(removedIdx, 1);
  }
}

/**
 * Check if an edge can be safely fused (removed).
 * An edge can be fused if at least one basis vector has a non-zero
 * value at that edge position.
 */
export function canFuseEdge(state: MorphogenesisState, edgeId: number): boolean {
  const edgeIdToIdx = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  const eIdx = edgeIdToIdx.get(edgeId);
  if (eIdx === undefined) return false;
  // Always possible — either it has zero stress (trivial removal)
  // or we can combine basis vectors to zero it out
  return true;
}
