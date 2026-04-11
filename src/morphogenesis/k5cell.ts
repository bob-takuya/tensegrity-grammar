/**
 * K₅ Cell: the elementary tensegrity unit.
 *
 * A K₅ cell is a complete graph on 5 nodes (10 edges).
 * In general position (no 4 coplanar), it always admits exactly
 * one state of self-stress with a 6+/4− sign pattern.
 *
 * Self-stress is computed analytically using tetrahedral volume
 * ratios (Aloui et al. 2019, Equation 13):
 *
 *   w_{ij} = (-1)^{i+j} × f(complement of {i,j} ∪ {i}) / f(complement of {i,j} ∪ {j})
 *
 * where f(A,B,C,D) = signed volume of tetrahedron ABCD.
 */

import { Vec3, MNode, MEdge, K5Cell, StructureGraph } from './types';
import { signedTetraVolume, isGeneralPosition, vdist } from './geometry';
import { findNullspaceBasis } from './linalg';

/**
 * Enumerate all 10 edges of K₅ on 5 nodes [0,1,2,3,4].
 * Returns pairs (i,j) with i < j, in lexicographic order.
 */
export function k5EdgePairs(): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      pairs.push([i, j]);
  return pairs;
}

/**
 * Compute the self-stress (force density vector) for a K₅ cell.
 *
 * Method: Build the equilibrium matrix A (15×10), find its nullspace,
 * then convert axial forces to force densities: q_ij = t_ij / L_ij.
 *
 * This is numerically exact and always works for general-position points.
 * Returns 10 force densities (one per edge, same order as k5EdgePairs()).
 *
 * Returns null if points are not in general position.
 */
export function computeK5SelfStress(points: Vec3[]): number[] | null {
  if (points.length !== 5) return null;
  if (!isGeneralPosition(points)) return null;

  const pairs = k5EdgePairs();

  // Build equilibrium matrix A (15 × 10)
  // 3 equations per node (x,y,z) × 5 nodes = 15 rows
  // 10 columns (one per edge)
  const A: number[][] = Array.from({ length: 15 }, () => new Array(10).fill(0));
  for (let e = 0; e < 10; e++) {
    const [ni, nj] = pairs[e];
    const dx = points[nj][0] - points[ni][0];
    const dy = points[nj][1] - points[ni][1];
    const dz = points[nj][2] - points[ni][2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-15) return null;

    // Positive force = tension (pulls endpoints together)
    A[3 * ni + 0][e] = dx / len;
    A[3 * ni + 1][e] = dy / len;
    A[3 * ni + 2][e] = dz / len;
    A[3 * nj + 0][e] = -dx / len;
    A[3 * nj + 1][e] = -dy / len;
    A[3 * nj + 2][e] = -dz / len;
  }

  // Find nullspace of A → self-stress (axial force vector)
  const basis = findNullspaceBasis(A);
  if (basis.length === 0) return null;

  // Convert axial forces to force densities: q = t / L
  const t = basis[0];
  const q: number[] = new Array(10);
  for (let e = 0; e < 10; e++) {
    const [ni, nj] = pairs[e];
    const len = vdist(points[ni], points[nj]);
    q[e] = t[e] / len;
  }

  return q;
}

/**
 * Classify the sign pattern of a K₅ self-stress.
 * Returns 'typeI' if 6 positive + 4 negative, 'typeII' if 4 positive + 6 negative.
 */
export function classifySignPattern(w: number[]): 'typeI' | 'typeII' {
  const nPos = w.filter(v => v > 0).length;
  return nPos >= 6 ? 'typeI' : 'typeII';
}

/**
 * Assign strut/cable types based on self-stress sign pattern.
 * Convention: positive force density = cable (tension),
 *             negative force density = strut (compression).
 */
export function assignTypes(w: number[]): ('strut' | 'cable')[] {
  return w.map(v => v > 0 ? 'cable' : 'strut');
}

/**
 * Create a K₅ cell in a StructureGraph.
 *
 * @param graph    The structure graph to add nodes/edges to
 * @param points   5 positions in general position
 * @param cellId   ID for the new cell
 * @returns        The K5Cell, or null if self-stress computation fails
 */
export function createK5Cell(
  graph: StructureGraph,
  points: Vec3[],
  cellId: number
): K5Cell | null {
  if (points.length !== 5) return null;

  const stress = computeK5SelfStress(points);
  if (!stress) return null;

  const pairs = k5EdgePairs();
  const types = assignTypes(stress);

  // Create nodes
  const nodeIds: number[] = [];
  for (const p of points) {
    const id = graph.nextNodeId++;
    graph.nodes.push({ id, pos: p });
    nodeIds.push(id);
  }

  // Create edges
  const edgeIds: number[] = [];
  for (let idx = 0; idx < 10; idx++) {
    const [li, lj] = pairs[idx]; // local indices
    const id = graph.nextEdgeId++;
    graph.edges.push({
      id,
      n: [nodeIds[li], nodeIds[lj]],
      type: types[idx],
      forceDensity: stress[idx],
    });
    edgeIds.push(id);
  }

  return {
    id: cellId,
    nodeIds,
    edgeIds,
    selfStress: stress,
    signPattern: classifySignPattern(stress),
  };
}

/**
 * Create a K₅ cell that shares existing nodes.
 *
 * @param graph       The structure graph
 * @param sharedIds   IDs of existing nodes to reuse (3 or 4)
 * @param newPoints   Positions for new nodes (2 or 1)
 * @param cellId      ID for the new cell
 */
export function createK5CellWithSharedNodes(
  graph: StructureGraph,
  sharedIds: number[],
  newPoints: Vec3[],
  cellId: number
): K5Cell | null {
  if (sharedIds.length + newPoints.length !== 5) return null;

  // Gather all 5 positions
  const allPositions: Vec3[] = [];
  const allNodeIds: number[] = [];

  for (const sid of sharedIds) {
    const node = graph.nodes.find(n => n.id === sid);
    if (!node) return null;
    allPositions.push(node.pos);
    allNodeIds.push(sid);
  }

  for (const p of newPoints) {
    const id = graph.nextNodeId++;
    graph.nodes.push({ id, pos: p });
    allPositions.push(p);
    allNodeIds.push(id);
  }

  // Compute self-stress
  const stress = computeK5SelfStress(allPositions);
  if (!stress) return null;

  const pairs = k5EdgePairs();
  const types = assignTypes(stress);

  // Create edges (skip if edge already exists between shared nodes)
  const edgeIds: number[] = [];
  for (let idx = 0; idx < 10; idx++) {
    const [li, lj] = pairs[idx];
    const ni = allNodeIds[li], nj = allNodeIds[lj];

    // Check if edge already exists
    const existing = graph.edges.find(e =>
      (e.n[0] === ni && e.n[1] === nj) || (e.n[0] === nj && e.n[1] === ni)
    );

    if (existing) {
      edgeIds.push(existing.id);
    } else {
      const id = graph.nextEdgeId++;
      graph.edges.push({
        id,
        n: [ni, nj],
        type: types[idx],
        forceDensity: stress[idx],
      });
      edgeIds.push(id);
    }
  }

  return {
    id: cellId,
    nodeIds: allNodeIds,
    edgeIds,
    selfStress: stress,
    signPattern: classifySignPattern(stress),
  };
}

/**
 * Verify that a self-stress satisfies equilibrium: A × w = 0.
 */
export function verifyEquilibrium(
  nodes: { id: number; pos: Vec3 }[],
  edges: { id: number; n: [number, number]; forceDensity: number }[]
): number {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  let maxRes = 0;

  for (const node of nodes) {
    let fx = 0, fy = 0, fz = 0;
    for (const edge of edges) {
      let other: typeof node | undefined;
      if (edge.n[0] === node.id) other = nodeMap.get(edge.n[1]);
      else if (edge.n[1] === node.id) other = nodeMap.get(edge.n[0]);
      else continue;
      if (!other) continue;

      const q = edge.forceDensity;
      fx += q * (other.pos[0] - node.pos[0]);
      fy += q * (other.pos[1] - node.pos[1]);
      fz += q * (other.pos[2] - node.pos[2]);
    }
    maxRes = Math.max(maxRes, Math.abs(fx), Math.abs(fy), Math.abs(fz));
  }
  return maxRes;
}
