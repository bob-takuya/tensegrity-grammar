/**
 * Morphogenesis Engine: top-level API for cellular morphogenesis.
 */

import { Vec3, MorphogenesisState, StructureGraph, K5Cell } from './types';
import { createK5Cell, verifyEquilibrium, k5EdgePairs } from './k5cell';
import { adhereCell, suggestNewPositions } from './adhesion';
import { fuseOneEdge } from './fusion';
import { isGeneralPosition } from './geometry';
import { findNullspaceBasis } from './linalg';

export function createEmptyState(): MorphogenesisState {
  return {
    graph: { nodes: [], edges: [], nextNodeId: 0, nextEdgeId: 0 },
    cells: [],
    boundaries: [],
    stressBasis: [],
    nextCellId: 0,
    history: [],
    historyIndex: -1,
  };
}

/**
 * Create the first K₅ cell (seed) from 5 arbitrary points.
 */
export function seed(state: MorphogenesisState, points: Vec3[]): boolean {
  if (points.length !== 5) return false;
  const cellId = state.nextCellId++;
  const cell = createK5Cell(state.graph, points, cellId);
  if (!cell) return false;

  state.cells.push(cell);

  // Add self-stress to basis (first entry)
  const fullStress = new Array(state.graph.edges.length).fill(0);
  const edgeIdToIdx = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  for (let k = 0; k < cell.edgeIds.length; k++) {
    const idx = edgeIdToIdx.get(cell.edgeIds[k]);
    if (idx !== undefined) fullStress[idx] = cell.selfStress[k];
  }
  state.stressBasis.push(fullStress);

  return true;
}

/**
 * Grow: adhere a new cell sharing 3 nodes, then optionally fuse 1 edge.
 *
 * This is the basic growth operation that produces non-linear structures.
 * The new node positions determine the growth direction.
 */
export function grow(
  state: MorphogenesisState,
  sharedNodeIds: number[],
  newPositions: Vec3[],
  fuseEdgeId?: number
): boolean {
  const cell = adhereCell(state, sharedNodeIds, newPositions);
  if (!cell) return false;

  if (fuseEdgeId !== undefined) {
    fuseOneEdge(state, fuseEdgeId);
  }

  return true;
}

/**
 * Auto-grow: generate a multi-cell structure automatically.
 *
 * Strategy:
 *   1. Seed with a single K₅ cell
 *   2. For each growth step:
 *     a. Pick a face (3 nodes) on the boundary of the structure
 *     b. Compute new node positions in a growth direction
 *     c. Adhere a new cell
 *     d. Optionally fuse 1 shared edge
 *
 * @param numCells   Total number of cells to generate
 * @param spreadFn   Optional function to determine growth direction
 */
/**
 * Auto-grow using Type II tetrahedral cells (Appendix C of Aloui 2019).
 *
 * Each cell is a tetrahedron (4 surface nodes) + its centroid (1 interior node).
 * The 4 edges from centroid to surface nodes are STRUTS.
 * The 6 edges between surface nodes are CABLES.
 *
 * This guarantees:
 *   - Surface nodes have exactly 1 strut per cell touching them
 *   - Shared faces (3 surface nodes) only carry cables
 *   - The centroid is the only node with multiple struts (4 per cell)
 *   → Surface nodes achieve Class-1
 *
 * Growth: pick a triangular face → place a new vertex + centroid outward.
 * The new tetrahedron shares the face (3 nodes) with the existing structure.
 */
export function autoGrow(
  state: MorphogenesisState,
  numCells: number,
  options: {
    baseRadius?: number;
    layerHeight?: number;
    spread?: number;
    fuseProbability?: number;
    maxCompDeg?: number;
  } = {}
): boolean {
  const {
    baseRadius = 1.5,
    layerHeight = 1.5,
    spread = 0.3,
    fuseProbability = 0.15,
    maxCompDeg = 1,
  } = options;

  // Step 1: Seed — first tetrahedron + centroid
  if (state.cells.length === 0) {
    const r = baseRadius;
    // Regular tetrahedron vertices
    const tetVerts: Vec3[] = [
      [r, 0, 0],
      [-r / 3, r * 0.943, 0],
      [-r / 3, -r * 0.471, r * 0.816],
      [-r / 3, -r * 0.471, -r * 0.816],
    ];
    const centroid: Vec3 = [
      (tetVerts[0][0] + tetVerts[1][0] + tetVerts[2][0] + tetVerts[3][0]) / 4,
      (tetVerts[0][1] + tetVerts[1][1] + tetVerts[2][1] + tetVerts[3][1]) / 4,
      (tetVerts[0][2] + tetVerts[1][2] + tetVerts[2][2] + tetVerts[3][2]) / 4,
    ];
    // K₅ = 4 tet vertices + centroid
    if (!seedTypeII(state, tetVerts, centroid)) return false;
  }

  // Step 2: Grow by adding tetrahedra sharing a face
  const targetCells = Math.max(1, numCells);
  while (state.cells.length < targetCells) {
    const faces = findGrowableFaces(state);
    if (faces.length === 0) break;

    // Pick a face (prefer outward-facing with some randomness)
    faces.sort((a, b) => {
      const za = a.reduce((s, id) => s + (state.graph.nodes.find(n => n.id === id)?.pos[2] || 0), 0);
      const zb = b.reduce((s, id) => s + (state.graph.nodes.find(n => n.id === id)?.pos[2] || 0), 0);
      return zb - za;
    });
    const topK = Math.min(5, faces.length);
    const face = faces[Math.floor(Math.random() * topK)];

    // Compute face centroid and outward normal
    const faceNodes = face.map(id => state.graph.nodes.find(n => n.id === id)!);
    const cx = faceNodes.reduce((s, n) => s + n.pos[0], 0) / 3;
    const cy = faceNodes.reduce((s, n) => s + n.pos[1], 0) / 3;
    const cz = faceNodes.reduce((s, n) => s + n.pos[2], 0) / 3;

    const a = faceNodes[0].pos, b = faceNodes[1].pos, c = faceNodes[2].pos;
    const ab: Vec3 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const ac: Vec3 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    let nx = ab[1]*ac[2] - ab[2]*ac[1];
    let ny = ab[2]*ac[0] - ab[0]*ac[2];
    let nz = ab[0]*ac[1] - ab[1]*ac[0];
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (nl > 1e-10) { nx /= nl; ny /= nl; nz /= nl; } else { nx = 0; ny = 0; nz = 1; }

    // Point outward from structure centroid
    const sc = [
      state.graph.nodes.reduce((s, n) => s + n.pos[0], 0) / state.graph.nodes.length,
      state.graph.nodes.reduce((s, n) => s + n.pos[1], 0) / state.graph.nodes.length,
      state.graph.nodes.reduce((s, n) => s + n.pos[2], 0) / state.graph.nodes.length,
    ];
    if (nx*(cx-sc[0]) + ny*(cy-sc[1]) + nz*(cz-sc[2]) < 0) { nx=-nx; ny=-ny; nz=-nz; }

    // Add spread
    const rx = (Math.random() - 0.5) * spread;
    const ry = (Math.random() - 0.5) * spread;
    const rz = (Math.random() - 0.5) * spread;
    let dx = nx + rx, dy = ny + ry, dz = nz + rz;
    const dl = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dl > 1e-10) { dx /= dl; dy /= dl; dz /= dl; }

    // New vertex: offset from face centroid along normal
    const h = layerHeight * (0.8 + Math.random() * 0.4);
    const newVert: Vec3 = [cx + dx * h, cy + dy * h, cz + dz * h];

    // Centroid of the new tetrahedron (3 face nodes + new vertex)
    const tetCentroid: Vec3 = [
      (cx * 3 + newVert[0]) / 4,
      (cy * 3 + newVert[1]) / 4,
      (cz * 3 + newVert[2]) / 4,
    ];

    // K₅ points: [face[0], face[1], face[2], newVert, tetCentroid]
    const allPos = [...face.map(id => state.graph.nodes.find(n => n.id === id)!.pos), newVert, tetCentroid];
    if (!isGeneralPosition(allPos)) continue;

    // Create the Type II cell: sharing face[0..2], new nodes = newVert + centroid
    const cell = adhereTypeII(state, face, newVert, tetCentroid);
    if (!cell) continue;

    // Optional fusion of a shared cable for variety
    if (Math.random() < fuseProbability) {
      const sharedSet = new Set(face);
      const sharedCables = state.graph.edges.filter(e =>
        e.type === 'cable' && sharedSet.has(e.n[0]) && sharedSet.has(e.n[1])
      );
      if (sharedCables.length > 0) {
        fuseOneEdge(state, sharedCables[Math.floor(Math.random() * sharedCables.length)].id);
      }
    }
  }

  // Final: recompute forces from the global equilibrium matrix
  recomputeForces(state, maxCompDeg);
  return state.cells.length > 0;
}

/**
 * Create a Type II K₅ cell: 4 tetrahedral vertices + 1 centroid.
 * Struts: centroid → each vertex (4 struts).
 * Cables: all pairs of vertices (6 cables).
 */
function seedTypeII(state: MorphogenesisState, tetVerts: Vec3[], centroid: Vec3): boolean {
  // K₅ points: [v0, v1, v2, v3, centroid]
  const points: Vec3[] = [...tetVerts, centroid];
  const cellId = state.nextCellId++;
  const cell = createK5Cell(state.graph, points, cellId);
  if (!cell) return false;

  // Force Type II assignment: edges 0-3→4 are struts, 0-1,0-2,0-3,1-2,1-3,2-3 are cables
  // In K₅ edge order (i<j): (0,1),(0,2),(0,3),(0,4),(1,2),(1,3),(1,4),(2,3),(2,4),(3,4)
  // Centroid is index 4. Edges to centroid: (0,4),(1,4),(2,4),(3,4) = indices 3,6,8,9
  const centroidEdges = new Set([3, 6, 8, 9]); // indices of edges touching node 4
  const pairs = k5EdgePairs();
  for (let i = 0; i < 10; i++) {
    const edge = state.graph.edges.find(e => e.id === cell.edgeIds[i])!;
    const isStrutEdge = centroidEdges.has(i);
    edge.type = isStrutEdge ? 'strut' : 'cable';
    edge.typeLocked = true; // Lock Type II assignment
    if (isStrutEdge && edge.forceDensity > 0) edge.forceDensity = -Math.abs(edge.forceDensity);
    if (!isStrutEdge && edge.forceDensity < 0) edge.forceDensity = Math.abs(edge.forceDensity);
  }

  state.cells.push(cell);
  const fullStress = new Array(state.graph.edges.length).fill(0);
  const edgeIdToIdx = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  for (let k = 0; k < cell.edgeIds.length; k++) {
    const idx = edgeIdToIdx.get(cell.edgeIds[k]);
    if (idx !== undefined) fullStress[idx] = cell.selfStress[k];
  }
  state.stressBasis.push(fullStress);
  return true;
}

/**
 * Adhere a new Type II cell sharing 3 face nodes.
 * The new cell has: shared[0..2] + newVertex + centroid.
 * Struts go from centroid to all 4 other nodes.
 * Cables go between all pairs of the 4 non-centroid nodes.
 */
function adhereTypeII(
  state: MorphogenesisState,
  faceIds: number[],
  newVertex: Vec3,
  centroid: Vec3
): K5Cell | null {
  // newPositions = [newVertex, centroid]
  // In the K₅, local indices: 0,1,2 = shared face, 3 = newVertex, 4 = centroid
  const cell = adhereCell(state, faceIds, [newVertex, centroid]);
  if (!cell) return null;

  // Force Type II: edges to centroid (local index 4) are struts, rest are cables
  const centroidIdx = 4; // local index of centroid in the 5-node cell
  const pairs = k5EdgePairs();
  for (let i = 0; i < 10; i++) {
    const [li, lj] = pairs[i];
    const edge = state.graph.edges.find(e => e.id === cell.edgeIds[i]);
    if (!edge) continue;
    const touchesCentroid = li === centroidIdx || lj === centroidIdx;
    edge.type = touchesCentroid ? 'strut' : 'cable';
    edge.typeLocked = true; // Lock Type II assignment
    if (touchesCentroid && edge.forceDensity > 0) edge.forceDensity = -Math.abs(edge.forceDensity);
    if (!touchesCentroid && edge.forceDensity < 0) edge.forceDensity = Math.abs(edge.forceDensity);
  }

  return cell;
}

/**
 * Recompute force densities on all edges from the equilibrium matrix
 * nullspace. Then optimize the linear combination of basis vectors
 * to minimize Class-k violations (max struts per node).
 */
function recomputeForces(state: MorphogenesisState, maxCompDeg: number = Infinity): void {
  const { nodes, edges } = state.graph;
  if (edges.length === 0 || nodes.length === 0) return;

  const m = edges.length, n = nodes.length;
  const nodeIdx = new Map(nodes.map((nd, i) => [nd.id, i]));

  // Build 3D equilibrium matrix A (3n × m)
  const A: number[][] = Array.from({ length: 3 * n }, () => new Array(m).fill(0));
  const lengths = new Array(m).fill(1);
  for (let e = 0; e < m; e++) {
    const [ni, nj] = edges[e].n;
    const pi = nodes.find(nd => nd.id === ni)!;
    const pj = nodes.find(nd => nd.id === nj)!;
    const dx = pj.pos[0] - pi.pos[0], dy = pj.pos[1] - pi.pos[1], dz = pj.pos[2] - pi.pos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) continue;
    lengths[e] = len;
    const ii = nodeIdx.get(ni)!, ij = nodeIdx.get(nj)!;
    A[3 * ii][e] = dx / len; A[3 * ii + 1][e] = dy / len; A[3 * ii + 2][e] = dz / len;
    A[3 * ij][e] = -dx / len; A[3 * ij + 1][e] = -dy / len; A[3 * ij + 2][e] = -dz / len;
  }

  const basis = findNullspaceBasis(A);
  if (basis.length === 0) return;
  state.stressBasis = basis;

  // Find the best linear combination of basis vectors:
  // minimize the number of Class-k violations.
  // Use random search over coefficient signs (+1 or -1) for each basis vector.
  const k = basis.length;

  // Build edge-to-node-indices map for fast lookup
  const edgeNodeMap: [number, number][] = edges.map(e => {
    const i = nodes.findIndex(nd => nd.id === e.n[0]);
    const j = nodes.findIndex(nd => nd.id === e.n[1]);
    return [i, j];
  });

  // Objective: find coefficients α for basis vectors that minimize
  // Class-k violations: max(0, strutCount(node) - maxCompDeg) summed over all nodes.
  // Use random search with continuous coefficients + gradient-like refinement.
  let bestCoeffs = new Array(k).fill(1);
  let bestViolations = Infinity;

  const countViolations = (coeffs: number[]): number => {
    const strutCount = new Array(n).fill(0);
    let lockViolations = 0;

    for (let e = 0; e < m; e++) {
      let val = 0;
      for (let i = 0; i < k; i++) val += coeffs[i] * basis[i][e];
      const q = val / lengths[e];
      const isNeg = q < -1e-10;

      // Penalize violating locked type assignments (heavy penalty)
      if (edges[e].typeLocked) {
        if (edges[e].type === 'strut' && !isNeg) lockViolations += 10;
        if (edges[e].type === 'cable' && isNeg) lockViolations += 10;
      }

      if (isNeg) {
        const [ni, nj] = edgeNodeMap[e];
        if (ni >= 0) strutCount[ni]++;
        if (nj >= 0) strutCount[nj]++;
      }
    }

    let classViolations = 0;
    for (let i = 0; i < n; i++) {
      if (strutCount[i] > maxCompDeg) classViolations += strutCount[i] - maxCompDeg;
    }

    // Also penalize cable-only nodes (every node should have at least 1 strut)
    let cableOnlyPenalty = 0;
    for (let i = 0; i < n; i++) {
      if (strutCount[i] === 0) {
        // Check if this node has any edges at all
        const hasEdges = edgeNodeMap.some(([a, b]) => a === i || b === i);
        if (hasEdges) cableOnlyPenalty += 5;
      }
    }

    return lockViolations + classViolations + cableOnlyPenalty;
  };

  // Try many random coefficient vectors
  const numTrials = Math.min(k * 200, 1000);
  for (let trial = 0; trial < numTrials; trial++) {
    const coeffs = new Array(k);
    for (let i = 0; i < k; i++) coeffs[i] = (Math.random() - 0.5) * 2;

    const v = countViolations(coeffs);
    if (v < bestViolations) {
      bestViolations = v;
      bestCoeffs = [...coeffs];
      if (v === 0) break;
    }

    // Also try with one large coefficient (emphasize one cell's stress)
    if (trial < k * 2) {
      const single = new Array(k).fill(0);
      const idx = trial % k;
      single[idx] = trial < k ? 1 : -1;
      const vs = countViolations(single);
      if (vs < bestViolations) {
        bestViolations = vs;
        bestCoeffs = [...single];
        if (vs === 0) break;
      }
    }
  }

  // Apply the best combination
  const combined = new Array(m).fill(0);
  for (let i = 0; i < k; i++) {
    for (let e = 0; e < m; e++) combined[e] += bestCoeffs[i] * basis[i][e];
  }

  for (let e = 0; e < m; e++) {
    edges[e].forceDensity = combined[e] / lengths[e];
    edges[e].type = edges[e].forceDensity > 1e-10 ? 'cable' : edges[e].forceDensity < -1e-10 ? 'strut' : 'cable';
  }
}

/**
 * Find triangular faces on the structure boundary that can accept new cells.
 */
function findGrowableFaces(state: MorphogenesisState): number[][] {
  const { nodes, edges } = state.graph;
  const faces: number[][] = [];

  // Build cable adjacency
  const adj = new Map<number, Set<number>>();
  for (const e of edges) {
    if (!adj.has(e.n[0])) adj.set(e.n[0], new Set());
    if (!adj.has(e.n[1])) adj.set(e.n[1], new Set());
    adj.get(e.n[0])!.add(e.n[1]);
    adj.get(e.n[1])!.add(e.n[0]);
  }

  // Find all triangles (3-cliques)
  const nodeIds = nodes.map(n => n.id);
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      if (!adj.get(nodeIds[i])?.has(nodeIds[j])) continue;
      for (let k = j + 1; k < nodeIds.length; k++) {
        if (!adj.get(nodeIds[j])?.has(nodeIds[k])) continue;
        if (!adj.get(nodeIds[k])?.has(nodeIds[i])) continue;
        faces.push([nodeIds[i], nodeIds[j], nodeIds[k]]);
      }
    }
  }

  return faces;
}

export { verifyEquilibrium } from './k5cell';
