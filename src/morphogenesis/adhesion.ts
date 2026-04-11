/**
 * Adhesion: attach a new K₅ cell to the existing structure.
 *
 * The new cell shares 3 or 4 nodes with the existing structure.
 * This adds one self-stress state to the basis (dim W += 1).
 *
 * The key improvement over the old prism stacking:
 *   - New node positions are FREE (not fixed above the previous module)
 *   - For 1-edge fusion: no geometric constraint on new node position
 *   - For 2-edge fusion: new node constrained to a quadric surface
 */

import { Vec3, MorphogenesisState, K5Cell, CellBoundary } from './types';
import { createK5CellWithSharedNodes, k5EdgePairs, computeK5SelfStress } from './k5cell';

/**
 * Adhere a new K₅ cell sharing `sharedNodeIds` with the existing structure.
 *
 * @param state       Current morphogenesis state
 * @param sharedIds   3 or 4 existing node IDs to share
 * @param newPositions Positions for new nodes (2 or 1)
 * @returns           The new cell, or null on failure
 */
export function adhereCell(
  state: MorphogenesisState,
  sharedIds: number[],
  newPositions: Vec3[]
): K5Cell | null {
  if (sharedIds.length + newPositions.length !== 5) return null;
  if (sharedIds.length < 3 || sharedIds.length > 4) return null;

  // Verify shared nodes exist
  for (const sid of sharedIds) {
    if (!state.graph.nodes.find(n => n.id === sid)) return null;
  }

  const cellId = state.nextCellId++;
  const cell = createK5CellWithSharedNodes(
    state.graph, sharedIds, newPositions, cellId
  );
  if (!cell) return null;

  // Add cell to state
  state.cells.push(cell);

  // Identify shared edges (edges between shared nodes)
  const sharedSet = new Set(sharedIds);
  const sharedEdges = state.graph.edges
    .filter(e => sharedSet.has(e.n[0]) && sharedSet.has(e.n[1]))
    .map(e => e.id);

  // Record boundary with any existing cells that share nodes
  for (const existingCell of state.cells) {
    if (existingCell.id === cellId) continue;
    const overlap = existingCell.nodeIds.filter(id => sharedSet.has(id));
    if (overlap.length >= 2) {
      const boundaryEdges = sharedEdges.filter(eid =>
        existingCell.edgeIds.includes(eid)
      );
      if (boundaryEdges.length > 0) {
        state.boundaries.push({
          cells: [existingCell.id, cellId],
          sharedEdges: boundaryEdges,
        });
      }
    }
  }

  // Add self-stress to basis
  // The new cell's self-stress vector, mapped to the full edge list
  const fullStress = new Array(state.graph.edges.length).fill(0);
  const edgeIdToIdx = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  for (let k = 0; k < cell.edgeIds.length; k++) {
    const idx = edgeIdToIdx.get(cell.edgeIds[k]);
    if (idx !== undefined) fullStress[idx] = cell.selfStress[k];
  }
  state.stressBasis.push(fullStress);

  return cell;
}

/**
 * Compute suggested positions for new nodes when attaching to
 * a set of shared nodes. This enables non-linear growth.
 *
 * The positions are computed by:
 *   1. Find the centroid and normal of the shared face
 *   2. Place new nodes offset from the centroid along the normal
 *   3. Add random perturbation for variety
 *
 * @param direction  Unit vector for growth direction (optional)
 */
export function suggestNewPositions(
  state: MorphogenesisState,
  sharedIds: number[],
  distance: number = 1.5,
  direction?: Vec3
): Vec3[] {
  const sharedNodes = sharedIds.map(id => state.graph.nodes.find(n => n.id === id)!);
  const nShared = sharedNodes.length;
  const nNew = 5 - nShared;

  // Centroid of shared face
  const cx = sharedNodes.reduce((s, n) => s + n.pos[0], 0) / nShared;
  const cy = sharedNodes.reduce((s, n) => s + n.pos[1], 0) / nShared;
  const cz = sharedNodes.reduce((s, n) => s + n.pos[2], 0) / nShared;

  // Compute face normal (using first 3 shared nodes)
  let normal: Vec3;
  if (direction) {
    normal = direction;
  } else if (nShared >= 3) {
    const a = sharedNodes[0].pos, b = sharedNodes[1].pos, c = sharedNodes[2].pos;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross: Vec3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const len = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
    normal = len > 1e-10 ? [cross[0] / len, cross[1] / len, cross[2] / len] : [0, 0, 1];
  } else {
    normal = [0, 0, 1];
  }

  // Generate new positions along the normal with random perturbation
  const positions: Vec3[] = [];
  for (let i = 0; i < nNew; i++) {
    const d = distance * (0.8 + Math.random() * 0.4);
    const rx = (Math.random() - 0.5) * distance * 0.5;
    const ry = (Math.random() - 0.5) * distance * 0.5;
    const rz = (Math.random() - 0.5) * distance * 0.5;
    positions.push([
      cx + normal[0] * d + rx,
      cy + normal[1] * d + ry,
      cz + normal[2] * d + rz,
    ]);
  }

  return positions;
}
