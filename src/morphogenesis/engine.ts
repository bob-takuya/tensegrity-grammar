/**
 * Morphogenesis Engine: top-level API for cellular morphogenesis.
 */

import { Vec3, MorphogenesisState, StructureGraph } from './types';
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
export function autoGrow(
  state: MorphogenesisState,
  numCells: number,
  options: {
    baseRadius?: number;
    layerHeight?: number;
    spread?: number;        // how much to deviate from straight-up (0=tower, 1=max spread)
    fuseProbability?: number;
    maxCompDeg?: number;    // max compression edges per node (1 = Class-1, Infinity = no limit)
  } = {}
): boolean {
  const {
    baseRadius = 1.5,
    layerHeight = 1.5,
    spread = 0.3,
    fuseProbability = 0.3,
    maxCompDeg = Infinity,
  } = options;

  // Step 1: Seed
  if (state.cells.length === 0) {
    const r = baseRadius;
    const h = layerHeight;
    const seedPoints: Vec3[] = [
      [r, 0, 0],
      [-r * 0.5, r * 0.866, 0],
      [-r * 0.5, -r * 0.866, 0],
      [0, 0, h],                 // top center
      [r * 0.3, r * 0.3, h * 0.6], // offset point for general position
    ];
    if (!seed(state, seedPoints)) return false;
  }

  // Step 2: Grow
  const targetCells = Math.max(1, numCells);
  while (state.cells.length < targetCells) {
    // Find boundary faces: triples of nodes that could be extended
    const faces = findGrowableFaces(state);
    if (faces.length === 0) break;

    // Pick a face (prefer higher z for upward growth, with some randomness)
    faces.sort((a, b) => {
      const za = a.reduce((s, id) => s + (state.graph.nodes.find(n => n.id === id)?.pos[2] || 0), 0);
      const zb = b.reduce((s, id) => s + (state.graph.nodes.find(n => n.id === id)?.pos[2] || 0), 0);
      return zb - za; // highest first
    });
    const topK = Math.min(3, faces.length);
    const face = faces[Math.floor(Math.random() * topK)];

    // Growth direction: face normal + random spread
    const nodes = face.map(id => state.graph.nodes.find(n => n.id === id)!);
    const cx = nodes.reduce((s, n) => s + n.pos[0], 0) / 3;
    const cy = nodes.reduce((s, n) => s + n.pos[1], 0) / 3;
    const cz = nodes.reduce((s, n) => s + n.pos[2], 0) / 3;

    // Face normal
    const a = nodes[0].pos, b = nodes[1].pos, c = nodes[2].pos;
    const ab: Vec3 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const ac: Vec3 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    let nx = ab[1]*ac[2] - ab[2]*ac[1];
    let ny = ab[2]*ac[0] - ab[0]*ac[2];
    let nz = ab[0]*ac[1] - ab[1]*ac[0];
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (nl > 1e-10) { nx /= nl; ny /= nl; nz /= nl; }
    else { nx = 0; ny = 0; nz = 1; }

    // Ensure normal points "outward" (away from structure centroid)
    const structCentroid = [
      state.graph.nodes.reduce((s, n) => s + n.pos[0], 0) / state.graph.nodes.length,
      state.graph.nodes.reduce((s, n) => s + n.pos[1], 0) / state.graph.nodes.length,
      state.graph.nodes.reduce((s, n) => s + n.pos[2], 0) / state.graph.nodes.length,
    ];
    const toFace = [cx - structCentroid[0], cy - structCentroid[1], cz - structCentroid[2]];
    if (nx * toFace[0] + ny * toFace[1] + nz * toFace[2] < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }

    // Add spread (random deviation from normal)
    const spreadAngle = spread * Math.PI * 0.5;
    const theta = Math.random() * spreadAngle;
    const phi = Math.random() * Math.PI * 2;
    // Rotate normal by theta around a random perpendicular axis
    const rx = (Math.random() - 0.5) * spread;
    const ry = (Math.random() - 0.5) * spread;
    const rz = (Math.random() - 0.5) * spread;
    const dir: Vec3 = [nx + rx, ny + ry, nz + rz];
    const dl = Math.sqrt(dir[0]**2 + dir[1]**2 + dir[2]**2);
    if (dl > 1e-10) { dir[0] /= dl; dir[1] /= dl; dir[2] /= dl; }

    // New node positions (2 nodes for sharing 3)
    const d = layerHeight;
    const newPos: Vec3[] = [
      [cx + dir[0] * d + (Math.random()-0.5)*0.5, cy + dir[1] * d + (Math.random()-0.5)*0.5, cz + dir[2] * d + (Math.random()-0.5)*0.5],
      [cx + dir[0] * d * 0.7 + (Math.random()-0.5)*0.8, cy + dir[1] * d * 0.7 + (Math.random()-0.5)*0.8, cz + dir[2] * d * 0.7 + (Math.random()-0.5)*0.8],
    ];

    // Check general position before creating
    const allPos = [...face.map(id => state.graph.nodes.find(n => n.id === id)!.pos), ...newPos];
    if (!isGeneralPosition(allPos)) continue;

    // Adhere
    const cell = adhereCell(state, face, newPos, maxCompDeg);
    if (!cell) continue;

    // Random cable fusion for variety (topology change)
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

  // Recompute force densities from the full equilibrium matrix nullspace,
  // then optimize strut/cable assignment for Class-k.
  recomputeForces(state, maxCompDeg);

  return state.cells.length > 0;
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
    // Build combined vector
    const strutCount = new Array(n).fill(0);
    for (let e = 0; e < m; e++) {
      let val = 0;
      for (let i = 0; i < k; i++) val += coeffs[i] * basis[i][e];
      if (val / lengths[e] < -1e-10) {
        const [ni, nj] = edgeNodeMap[e];
        if (ni >= 0) strutCount[ni]++;
        if (nj >= 0) strutCount[nj]++;
      }
    }
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (strutCount[i] > maxCompDeg) v += strutCount[i] - maxCompDeg;
    }
    return v;
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
