/**
 * Morphogenesis Engine: prism-based tensegrity generation.
 *
 * Each cell is a 3-strut tensegrity prism:
 *   - 6 nodes (3 bottom + 3 top)
 *   - 3 struts (bottom[i] → top[i])
 *   - 9 cables (3 bottom ring + 3 top ring + 3 diagonals)
 *   - Each node has EXACTLY 1 strut → Class-1 within the cell
 *
 * Growth: stack new prism cells on the top face, or attach side-by-side.
 * Stacking creates shared nodes with 2 struts (Class-2 at interface).
 * For pure Class-1, cells are connected via cable-only bridges.
 */

import { Vec3, MorphogenesisState, StructureGraph, K5Cell } from './types';
import { solve, findNullspaceBasis } from './linalg';

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

// ─── Helpers ─────────────────────────────────────────────────────

function addNode(state: MorphogenesisState, pos: Vec3): number {
  const id = state.graph.nextNodeId++;
  state.graph.nodes.push({ id, pos });
  return id;
}

function addEdge(state: MorphogenesisState, a: number, b: number, type: 'strut' | 'cable', forceDensity: number): number {
  const existing = state.graph.edges.find(e =>
    (e.n[0] === a && e.n[1] === b) || (e.n[0] === b && e.n[1] === a)
  );
  if (existing) return existing.id;

  const id = state.graph.nextEdgeId++;
  state.graph.edges.push({
    id, n: [a, b], type, forceDensity, typeLocked: true,
  });
  return id;
}

function nodePos(state: MorphogenesisState, id: number): Vec3 {
  const n = state.graph.nodes.find(nd => nd.id === id);
  return n ? n.pos : [0, 0, 0];
}

function compressionDegree(state: MorphogenesisState, nodeId: number): number {
  return state.graph.edges.filter(e =>
    e.type === 'strut' && (e.n[0] === nodeId || e.n[1] === nodeId)
  ).length;
}

// ─── 3-Strut Prism Form-Finding ──────────────────────────────────

/**
 * Solve for the top ring positions of a 3-strut prism given bottom positions.
 * Uses the partitioned force density method with centroid constraint.
 *
 * Force densities: qStrut=-1, qRing=0.5, qDiag=1.0
 */
function formFindPrismTop(
  bottomPos: Vec3[],
  targetHeight: number
): Vec3[] | null {
  const N = 3;
  const qStrut = -1, qRing = 0.5, qDiag = 1.0;

  // D (2N × 2N): 0..N-1 = bottom, N..2N-1 = top
  const nN = 2 * N;
  const L: number[][] = Array.from({ length: nN }, () => new Array(nN).fill(0));
  const addQ = (i: number, j: number, q: number) => {
    L[i][i] += q; L[j][j] += q; L[i][j] -= q; L[j][i] -= q;
  };
  for (let k = 0; k < N; k++) {
    addQ(k, N + k, qStrut);             // strut b_k → t_k
    addQ(k, (k + 1) % N, qRing);        // bottom ring
    addQ(N + k, N + (k + 1) % N, qRing); // top ring
    addQ(k, N + (k + 1) % N, qDiag);    // diagonal
  }

  // L_tt and L_tb
  const L_tt: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => L[N + i][N + j])
  );
  const L_tb: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => L[N + i][j])
  );

  const bx = bottomPos.map(p => p[0]);
  const by = bottomPos.map(p => p[1]);

  const rhsX = new Array(N).fill(0), rhsY = new Array(N).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    rhsX[i] -= L_tb[i][j] * bx[j];
    rhsY[i] -= L_tb[i][j] * by[j];
  }

  // Centroid constraint (L_tt singular): last row = [1,1,...,1], rhs = sum_centroid
  const L_reg = L_tt.map(row => [...row]);
  for (let j = 0; j < N; j++) L_reg[N - 1][j] = 1;
  const cxSum = bx.reduce((s, v) => s + v, 0);
  const cySum = by.reduce((s, v) => s + v, 0);
  rhsX[N - 1] = cxSum;
  rhsY[N - 1] = cySum;

  const tx = solve(L_reg, rhsX);
  const ty = solve(L_reg, rhsY);
  if (!tx || !ty) return null;

  // Bottom centroid z
  const cz = bottomPos.reduce((s, p) => s + p[2], 0) / N;
  return tx.map((x, i) => [x, ty[i], cz + targetHeight] as Vec3);
}

// ─── Create a 3-Strut Prism Cell ─────────────────────────────────

interface PrismCell {
  id: number;
  bottomIds: number[];  // 3 node ids
  topIds: number[];     // 3 node ids
  strutEdgeIds: number[];
  cableEdgeIds: number[];
}

/**
 * Create a 3-strut prism cell with given bottom node IDs (must already exist)
 * and new top node positions (will be added).
 */
function createPrismCell(
  state: MorphogenesisState,
  bottomIds: number[],
  topPositions: Vec3[]
): PrismCell | null {
  if (bottomIds.length !== 3 || topPositions.length !== 3) return null;

  // Add top nodes
  const topIds = topPositions.map(p => addNode(state, p));

  // Force densities matching the form-finding solution
  const Q_STRUT = -1, Q_RING = 0.5, Q_DIAG = 1.0;

  const strutEdgeIds: number[] = [];
  const cableEdgeIds: number[] = [];

  // Struts: b[i] → t[i]
  for (let i = 0; i < 3; i++) {
    strutEdgeIds.push(addEdge(state, bottomIds[i], topIds[i], 'strut', Q_STRUT));
  }

  // Bottom ring cables: b[i] → b[(i+1)%3]
  for (let i = 0; i < 3; i++) {
    cableEdgeIds.push(addEdge(state, bottomIds[i], bottomIds[(i + 1) % 3], 'cable', Q_RING));
  }

  // Top ring cables: t[i] → t[(i+1)%3]
  for (let i = 0; i < 3; i++) {
    cableEdgeIds.push(addEdge(state, topIds[i], topIds[(i + 1) % 3], 'cable', Q_RING));
  }

  // Diagonal cables: b[i] → t[(i+1)%3]
  for (let i = 0; i < 3; i++) {
    cableEdgeIds.push(addEdge(state, bottomIds[i], topIds[(i + 1) % 3], 'cable', Q_DIAG));
  }

  const cellId = state.nextCellId++;
  return { id: cellId, bottomIds, topIds, strutEdgeIds, cableEdgeIds };
}

// ─── Seed: first prism ───────────────────────────────────────────

function seedPrism(state: MorphogenesisState, radius: number = 1.5): PrismCell | null {
  // 3 bottom nodes on a circle at z=0
  const bottomPos: Vec3[] = [
    [radius, 0, 0],
    [radius * Math.cos(2 * Math.PI / 3), radius * Math.sin(2 * Math.PI / 3), 0],
    [radius * Math.cos(4 * Math.PI / 3), radius * Math.sin(4 * Math.PI / 3), 0],
  ];
  const bottomIds = bottomPos.map(p => addNode(state, p));

  // Form-find top positions
  const topPos = formFindPrismTop(bottomPos, 2.0);
  if (!topPos) return null;

  return createPrismCell(state, bottomIds, topPos);
}

// ─── Adhere: new prism on top face ───────────────────────────────

function adherePrism(
  state: MorphogenesisState,
  sharedIds: number[],  // 3 existing nodes that become the new cell's bottom
  heightOffset: number,
  directionSpread: number = 0
): PrismCell | null {
  if (sharedIds.length !== 3) return null;

  const bottomPos = sharedIds.map(id => nodePos(state, id));

  // Form-find top positions
  const topPos = formFindPrismTop(bottomPos, heightOffset);
  if (!topPos) return null;

  // Add random spread for variety
  if (directionSpread > 0) {
    for (const p of topPos) {
      p[0] += (Math.random() - 0.5) * directionSpread;
      p[1] += (Math.random() - 0.5) * directionSpread;
    }
  }

  return createPrismCell(state, sharedIds, topPos);
}

// ─── Auto-Grow ───────────────────────────────────────────────────

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
    layerHeight = 1.8,
    spread = 0.2,
    // maxCompDeg not used with prism approach (inherently Class-2 at interfaces)
  } = options;

  // Seed
  if (state.cells.length === 0) {
    const cell = seedPrism(state, baseRadius);
    if (!cell) return false;
    state.cells.push(cell as any);
  }

  // Track current top ring for stacking
  let currentTopIds = (state.cells[state.cells.length - 1] as any as PrismCell).topIds;

  // Grow by stacking
  for (let i = 1; i < numCells; i++) {
    const cell = adherePrism(state, currentTopIds, layerHeight, spread);
    if (!cell) break;
    state.cells.push(cell as any);
    currentTopIds = cell.topIds;
  }

  // Build stress basis from the full structure
  recomputeStressBasis(state);

  return state.cells.length > 0;
}

// ─── Stress Basis + Force Density Recomputation ────────────────

/**
 * Rebuild the stress basis from the equilibrium matrix and
 * assign force densities from a linear combination that matches
 * the locked strut/cable type assignment.
 */
function recomputeStressBasis(state: MorphogenesisState): void {
  const { nodes, edges } = state.graph;
  if (edges.length === 0 || nodes.length === 0) return;

  const m = edges.length, n = nodes.length;
  const nodeIdx = new Map(nodes.map((nd, i) => [nd.id, i]));

  // Build equilibrium matrix A (3n × m)
  const A: number[][] = Array.from({ length: 3 * n }, () => new Array(m).fill(0));
  const lengths = new Array(m).fill(1);
  for (let e = 0; e < m; e++) {
    const [ni, nj] = edges[e].n;
    const pi = nodes.find(nd => nd.id === ni)!;
    const pj = nodes.find(nd => nd.id === nj)!;
    const dx = pj.pos[0] - pi.pos[0];
    const dy = pj.pos[1] - pi.pos[1];
    const dz = pj.pos[2] - pi.pos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) continue;
    lengths[e] = len;
    const ii = nodeIdx.get(ni)!, ij = nodeIdx.get(nj)!;
    A[3 * ii][e] = dx / len; A[3 * ii + 1][e] = dy / len; A[3 * ii + 2][e] = dz / len;
    A[3 * ij][e] = -dx / len; A[3 * ij + 1][e] = -dy / len; A[3 * ij + 2][e] = -dz / len;
  }

  const basis = findNullspaceBasis(A);
  state.stressBasis = basis;
  if (basis.length === 0) return;

  // Find a linear combination α₁w₁ + α₂w₂ + ... that matches the type pattern:
  // struts should have negative values, cables positive.
  const k = basis.length;

  // Target sign pattern from locked types
  const targetSigns = edges.map(e => e.type === 'strut' ? -1 : 1);

  // Find best combination via random search (then sign-flip refinement)
  let bestCoeffs = new Array(k).fill(0);
  bestCoeffs[0] = 1;
  let bestScore = -Infinity;

  const scoreCombo = (coeffs: number[]): number => {
    // Build combined stress vector
    const t = new Array(m).fill(0);
    for (let i = 0; i < k; i++) {
      for (let e = 0; e < m; e++) t[e] += coeffs[i] * basis[i][e];
    }
    // Score: count edges where sign matches target (positive match) minus mismatches
    let score = 0;
    for (let e = 0; e < m; e++) {
      const mag = Math.abs(t[e]);
      if (mag < 1e-10) continue; // zero forces don't count either way
      const sign = t[e] > 0 ? 1 : -1;
      score += sign === targetSigns[e] ? mag : -mag;
    }
    return score;
  };

  // Try all ±1 combinations for small k, random for large k
  const numTrials = k <= 8 ? (1 << k) : 500;
  for (let trial = 0; trial < numTrials; trial++) {
    const coeffs = new Array(k);
    if (k <= 8) {
      for (let i = 0; i < k; i++) coeffs[i] = ((trial >> i) & 1) ? 1 : -1;
    } else {
      for (let i = 0; i < k; i++) coeffs[i] = (Math.random() - 0.5) * 2;
    }
    const s = scoreCombo(coeffs);
    if (s > bestScore) { bestScore = s; bestCoeffs = [...coeffs]; }
  }

  // Build the final stress and convert to force densities (q = t / L)
  const t = new Array(m).fill(0);
  for (let i = 0; i < k; i++) {
    for (let e = 0; e < m; e++) t[e] += bestCoeffs[i] * basis[i][e];
  }

  // Normalize the overall magnitude (scale so max |q| = 1)
  let maxQ = 0;
  for (let e = 0; e < m; e++) maxQ = Math.max(maxQ, Math.abs(t[e] / lengths[e]));
  const scale = maxQ > 1e-12 ? 1 / maxQ : 1;

  for (let e = 0; e < m; e++) {
    const q = (t[e] / lengths[e]) * scale;
    edges[e].forceDensity = q;
    // Update type based on ACTUAL sign (locked types may be overridden by math)
    if (!edges[e].typeLocked) {
      edges[e].type = q > 1e-10 ? 'cable' : q < -1e-10 ? 'strut' : edges[e].type;
    }
  }
}

// ─── Verify ──────────────────────────────────────────────────────

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

// ─── Helpers for compatibility ───────────────────────────────────

export function seed(state: MorphogenesisState, _points: Vec3[]): boolean {
  const cell = seedPrism(state, 1.5);
  if (!cell) return false;
  state.cells.push(cell as any);
  recomputeStressBasis(state);
  return true;
}

export function grow(
  state: MorphogenesisState,
  sharedNodeIds: number[],
  _newPositions: Vec3[],
  _fuseEdgeId?: number
): boolean {
  if (sharedNodeIds.length !== 3) return false;
  const cell = adherePrism(state, sharedNodeIds, 1.8, 0.2);
  if (!cell) return false;
  state.cells.push(cell as any);
  recomputeStressBasis(state);
  return true;
}
