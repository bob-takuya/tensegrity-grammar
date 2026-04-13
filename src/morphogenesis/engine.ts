/**
 * Cellular Morphogenesis Engine (Aloui, Orden, Rhode-Barbarigos 2019)
 *
 * Proper implementation of the paper's approach:
 *
 *   1. Build blocks = K₅ tensegrity cells (complete graph on 5 nodes, 10 edges)
 *   2. ADHESION: add new cell sharing 3 or 4 nodes with existing structure.
 *      Each cell contributes a new self-stress basis vector (Eq. 13 via nullspace).
 *   3. FUSION: remove edges by LINEAR COMBINATION of self-stress basis vectors
 *      so the target edge's force density becomes zero.
 *      - Single edge: β = -w_existing[e] / w_new[e], always works (Appendix B).
 *      - Multiple edges: geometric constraints on new node positions (Eqs 15-19).
 *
 * Triplex example from Section 5.1:
 *   Cell 1 (ABCDE) + Cell 2 (BCDEF) → adhere → 2 basis vectors
 *   Remove edges BD and CE (quadric constraint on E and F positions)
 *   Result: 6 nodes, 12 edges Triplex with 1 self-stress state
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

// ─── Basic helpers ───────────────────────────────────────────────

function addNode(state: MorphogenesisState, pos: Vec3): number {
  const id = state.graph.nextNodeId++;
  state.graph.nodes.push({ id, pos });
  return id;
}

function nodePos(state: MorphogenesisState, id: number): Vec3 {
  return state.graph.nodes.find(n => n.id === id)?.pos || [0, 0, 0];
}

function findEdge(state: MorphogenesisState, a: number, b: number) {
  return state.graph.edges.find(e =>
    (e.n[0] === a && e.n[1] === b) || (e.n[0] === b && e.n[1] === a)
  );
}

function addOrGetEdge(state: MorphogenesisState, a: number, b: number): number {
  const existing = findEdge(state, a, b);
  if (existing) return existing.id;
  const id = state.graph.nextEdgeId++;
  state.graph.edges.push({
    id, n: [a, b], type: 'cable', forceDensity: 0, typeLocked: false,
  });
  return id;
}

// ─── K₅ Cell self-stress via equilibrium matrix nullspace ───────

/**
 * Given 5 points in general position, compute the self-stress axial forces
 * from the nullspace of the equilibrium matrix. Returns 10 axial force values
 * in the order: (0,1), (0,2), (0,3), (0,4), (1,2), (1,3), (1,4), (2,3), (2,4), (3,4).
 */
function computeK5Stress(points: Vec3[]): number[] | null {
  if (points.length !== 5) return null;

  // Edge pairs in order
  const pairs: [number, number][] = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) pairs.push([i, j]);

  // Build equilibrium matrix A (3·5=15 rows × 10 cols)
  const A: number[][] = Array.from({ length: 15 }, () => new Array(10).fill(0));
  for (let e = 0; e < 10; e++) {
    const [i, j] = pairs[e];
    const dx = points[j][0] - points[i][0];
    const dy = points[j][1] - points[i][1];
    const dz = points[j][2] - points[i][2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-15) return null;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    A[3 * i][e] = ux; A[3 * i + 1][e] = uy; A[3 * i + 2][e] = uz;
    A[3 * j][e] = -ux; A[3 * j + 1][e] = -uy; A[3 * j + 2][e] = -uz;
  }

  const basis = findNullspaceBasis(A);
  if (basis.length === 0) return null;
  return basis[0]; // axial forces t_i
}

// ─── Adhesion: add K₅ cell sharing existing nodes ───────────────

interface K5CellInfo {
  id: number;
  nodeIds: number[];        // 5 node IDs in cell-local order
  edgeIds: number[];        // 10 edge IDs in K₅-pair order
  stressVector: number[];   // length = current total edges; sparse (zero outside this cell)
}

/**
 * Create a K₅ cell sharing `sharedIds` (3 or 4) with existing structure.
 * New nodes are added with positions from `newPositions`.
 * Returns the cell or null if creation fails.
 */
function adhereCell(
  state: MorphogenesisState,
  sharedIds: number[],
  newPositions: Vec3[]
): K5CellInfo | null {
  if (sharedIds.length + newPositions.length !== 5) return null;
  if (sharedIds.length < 3 || sharedIds.length > 4) return null;

  // Create new nodes
  const newIds = newPositions.map(p => addNode(state, p));
  const nodeIds = [...sharedIds, ...newIds];
  const points = nodeIds.map(id => nodePos(state, id));

  // Compute self-stress for the cell
  const cellStress = computeK5Stress(points);
  if (!cellStress) return null;

  // Create/get edges (10 K₅ edges)
  const edgeIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      edgeIds.push(addOrGetEdge(state, nodeIds[i], nodeIds[j]));
    }
  }

  // Build the cell's stress vector in the FULL edge-index space
  const edgeIdxMap = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  const fullStress = new Array(state.graph.edges.length).fill(0);
  for (let k = 0; k < 10; k++) {
    const idx = edgeIdxMap.get(edgeIds[k]);
    if (idx !== undefined) fullStress[idx] = cellStress[k];
  }

  // Extend ALL existing basis vectors to the new edge count (pad with zeros)
  for (let b = 0; b < state.stressBasis.length; b++) {
    while (state.stressBasis[b].length < state.graph.edges.length) {
      state.stressBasis[b].push(0);
    }
  }

  state.stressBasis.push(fullStress);

  const cellId = state.nextCellId++;
  state.cells.push({ id: cellId, nodeIds, edgeIds, selfStress: cellStress, signPattern: 'typeI' } as any);

  return { id: cellId, nodeIds, edgeIds, stressVector: fullStress };
}

// ─── Fusion: remove an edge via stress basis linear combination ─

/**
 * Remove edge `edgeId` via Gauss elimination on the stress basis.
 *
 * Algorithm:
 *   1. Find all basis vectors with non-zero value at this edge (contributors)
 *   2. Pick one as pivot (w₀ with value v₀)
 *   3. For each other contributor wᵢ: wᵢ_new = wᵢ + (-vᵢ/v₀) × w₀
 *      This zeros out the edge in all non-pivot contributors
 *   4. Remove the pivot basis vector (its value at the edge was not zeroed)
 *   5. Remove the edge from the graph
 *
 * Result: basis dimension decreases by 1, remaining vectors all have zero at the edge.
 */
function fuseEdge(state: MorphogenesisState, edgeId: number): boolean {
  const edgeIdx = state.graph.edges.findIndex(e => e.id === edgeId);
  if (edgeIdx === -1) return false;

  // Extend basis vectors to current edge count
  for (const b of state.stressBasis) {
    while (b.length < state.graph.edges.length) b.push(0);
  }

  // Find contributors
  const contributors: number[] = [];
  for (let b = 0; b < state.stressBasis.length; b++) {
    if (Math.abs(state.stressBasis[b][edgeIdx]) > 1e-12) contributors.push(b);
  }

  if (contributors.length === 0) {
    // Nothing to do for the basis; just remove the edge
    removeEdgeFromBasis(state, edgeIdx, edgeId);
    return true;
  }

  // Pick last contributor as pivot (so splicing doesn't affect earlier indices)
  const pivotBasisIdx = contributors[contributors.length - 1];
  const w0 = state.stressBasis[pivotBasisIdx];
  const v0 = w0[edgeIdx];

  // Zero out the edge in all non-pivot contributors via Gauss elimination
  for (let i = 0; i < contributors.length - 1; i++) {
    const ci = contributors[i];
    const wi = state.stressBasis[ci];
    const vi = wi[edgeIdx];
    const beta = -vi / v0;
    state.stressBasis[ci] = wi.map((val, k) => val + beta * w0[k]);
  }

  // Remove the pivot basis vector
  state.stressBasis.splice(pivotBasisIdx, 1);

  // Remove the edge
  removeEdgeFromBasis(state, edgeIdx, edgeId);
  return true;
}

function removeEdgeFromBasis(state: MorphogenesisState, edgeIdx: number, edgeId: number): void {
  state.graph.edges.splice(edgeIdx, 1);
  for (let b = 0; b < state.stressBasis.length; b++) {
    state.stressBasis[b].splice(edgeIdx, 1);
  }
  // Remove from cell edge lists
  for (const cell of state.cells) {
    (cell as any).edgeIds = (cell as any).edgeIds.filter((id: number) => id !== edgeId);
  }
}

// ─── Seed: first K₅ cell ────────────────────────────────────────

function seedCell(state: MorphogenesisState, radius: number = 1.5): K5CellInfo | null {
  // 5 points in general position (non-coplanar tetrahedron + apex)
  const points: Vec3[] = [
    [radius, 0, 0],
    [-radius * 0.5, radius * 0.866, 0],
    [-radius * 0.5, -radius * 0.866, 0],
    [0, 0, radius * 1.5],
    [0.3, 0.2, radius * 0.7],
  ];

  const nodeIds = points.map(p => addNode(state, p));
  const cellStress = computeK5Stress(points);
  if (!cellStress) return null;

  const edgeIds: number[] = [];
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      edgeIds.push(addOrGetEdge(state, nodeIds[i], nodeIds[j]));

  const fullStress = new Array(state.graph.edges.length).fill(0);
  const edgeIdxMap = new Map(state.graph.edges.map((e, i) => [e.id, i]));
  for (let k = 0; k < 10; k++) {
    const idx = edgeIdxMap.get(edgeIds[k]);
    if (idx !== undefined) fullStress[idx] = cellStress[k];
  }

  state.stressBasis.push(fullStress);
  const cellId = state.nextCellId++;
  state.cells.push({ id: cellId, nodeIds, edgeIds, selfStress: cellStress, signPattern: 'typeI' } as any);
  return { id: cellId, nodeIds, edgeIds, stressVector: fullStress };
}

// ─── Auto-grow: adhesion + fusion sequence ──────────────────────

export function autoGrow(
  state: MorphogenesisState,
  numCells: number,
  options: {
    baseRadius?: number;
    spread?: number;
    fuseProbability?: number;
    maxCompDeg?: number;
  } = {}
): boolean {
  const { baseRadius = 1.5, spread = 0.5, fuseProbability = 0.5 } = options;

  if (state.cells.length === 0) {
    if (!seedCell(state, baseRadius)) return false;
  }

  for (let step = 1; step < numCells; step++) {
    const nodeIds = state.graph.nodes.map(n => n.id);
    if (nodeIds.length < 4) break;

    // Prefer RECENTLY added 4 nodes (end of list) for organic growth
    // With some randomization
    const recentIds = nodeIds.slice(-Math.min(8, nodeIds.length));
    shuffleArray(recentIds);
    const sharedIds = recentIds.slice(0, 4);

    const sharedPos = sharedIds.map(id => nodePos(state, id));
    const cx = sharedPos.reduce((s, p) => s + p[0], 0) / 4;
    const cy = sharedPos.reduce((s, p) => s + p[1], 0) / 4;
    const cz = sharedPos.reduce((s, p) => s + p[2], 0) / 4;

    // Place new node offset from the shared face centroid
    const r = 1.5 + Math.random() * 0.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const newPos: Vec3 = [
      cx + r * Math.sin(phi) * Math.cos(theta),
      cy + r * Math.sin(phi) * Math.sin(theta),
      cz + r * Math.cos(phi) + spread,
    ];

    if (!isGeneralPos([...sharedPos, newPos])) continue;

    const cell = adhereCell(state, sharedIds, [newPos]);
    if (!cell) continue;

    // Optional fusion: remove one shared K₄ edge to create interesting topology
    if (Math.random() < fuseProbability) {
      const sharedEdges: number[] = [];
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const edge = findEdge(state, sharedIds[i], sharedIds[j]);
          if (edge) sharedEdges.push(edge.id);
        }
      }
      if (sharedEdges.length > 0) {
        shuffleArray(sharedEdges);
        fuseEdge(state, sharedEdges[0]);
      }
    }
  }

  assignTypesFromBasis(state);
  return state.cells.length > 0;
}

/**
 * After all adhesion+fusion operations, assign strut/cable types based
 * on the sign of force densities in a chosen linear combination of
 * basis vectors. Uses the sum of basis vectors by default, then optionally
 * flips signs to favor a target Class.
 */
function assignTypesFromBasis(state: MorphogenesisState): void {
  const { edges } = state.graph;
  const m = edges.length;
  if (m === 0 || state.stressBasis.length === 0) return;

  // Compute edge lengths for q = t/L conversion
  const lengths = new Array(m).fill(1);
  for (let e = 0; e < m; e++) {
    const [a, b] = edges[e].n;
    const pa = nodePos(state, a), pb = nodePos(state, b);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
    lengths[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Pad basis vectors to full edge count
  for (const b of state.stressBasis) {
    while (b.length < m) b.push(0);
  }

  // Try ±1 combinations of basis vectors; pick the one that maximizes
  // the number of nodes with exactly 1 strut (Class-1 proximity)
  const k = state.stressBasis.length;
  const nTrials = k <= 10 ? (1 << k) : 500;

  let bestCombined: number[] = new Array(m).fill(0);
  let bestScore = -Infinity;

  const nodeIdxMap = new Map(state.graph.nodes.map((n, i) => [n.id, i]));

  for (let trial = 0; trial < nTrials; trial++) {
    const coeffs = new Array(k);
    if (k <= 10) {
      for (let i = 0; i < k; i++) coeffs[i] = ((trial >> i) & 1) ? 1 : -1;
    } else {
      for (let i = 0; i < k; i++) coeffs[i] = (Math.random() - 0.5) * 2;
    }

    // Compute combined axial forces
    const t = new Array(m).fill(0);
    for (let i = 0; i < k; i++)
      for (let e = 0; e < m; e++)
        t[e] += coeffs[i] * state.stressBasis[i][e];

    // For each edge, try both sign orientations (since flipping all signs
    // gives a valid self-stress too)
    for (const signFlip of [1, -1]) {
      const strutCount = new Array(state.graph.nodes.length).fill(0);
      const cableCount = new Array(state.graph.nodes.length).fill(0);
      let nStruts = 0, nCables = 0;
      for (let e = 0; e < m; e++) {
        const q = signFlip * t[e] / lengths[e];
        if (Math.abs(q) < 1e-10) continue;
        const ai = nodeIdxMap.get(edges[e].n[0])!;
        const bi = nodeIdxMap.get(edges[e].n[1])!;
        if (q < 0) {
          strutCount[ai]++; strutCount[bi]++; nStruts++;
        } else {
          cableCount[ai]++; cableCount[bi]++; nCables++;
        }
      }

      if (nStruts === 0 || nCables === 0) continue; // must have both

      // Score: strongly prefer every node has ≥1 strut; penalize cable-only
      let score = 0;
      for (let i = 0; i < strutCount.length; i++) {
        const s = strutCount[i], c = cableCount[i];
        if (s === 0 && c > 0) score -= 100; // cable-only node = forbidden
        else if (s === 1) score += 10;
        else if (s === 2) score += 3;
        else if (s === 3) score += 1;
        else if (s > 3) score -= 2 * (s - 3);
      }
      // Also prefer fewer struts overall
      score -= nStruts * 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestCombined = t.map(v => v * signFlip);
      }
    }
  }

  // Assign types from best combination
  for (let e = 0; e < m; e++) {
    const q = bestCombined[e] / lengths[e];
    edges[e].forceDensity = q;
    edges[e].type = q > 1e-10 ? 'cable' : q < -1e-10 ? 'strut' : 'cable';
    edges[e].typeLocked = false;
  }
}

// ─── Utility ─────────────────────────────────────────────────────

function isGeneralPos(points: Vec3[]): boolean {
  // Check: no 4 points coplanar (det of 4×4 matrix ≠ 0)
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      for (let k = j + 1; k < points.length; k++) {
        for (let l = k + 1; l < points.length; l++) {
          const a = points[i], b = points[j], c = points[k], d = points[l];
          const v1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
          const v2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
          const v3 = [d[0]-a[0], d[1]-a[1], d[2]-a[2]];
          const det = v1[0]*(v2[1]*v3[2] - v2[2]*v3[1])
                    - v1[1]*(v2[0]*v3[2] - v2[2]*v3[0])
                    + v1[2]*(v2[0]*v3[1] - v2[1]*v3[0]);
          if (Math.abs(det) < 1e-6) return false;
        }
      }
    }
  }
  return true;
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Verification ────────────────────────────────────────────────

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

// ─── Legacy API for compatibility ───────────────────────────────

export function seed(state: MorphogenesisState, _points: Vec3[]): boolean {
  const ok = seedCell(state, 1.5);
  if (ok) assignTypesFromBasis(state);
  return !!ok;
}

export function grow(
  state: MorphogenesisState,
  sharedNodeIds: number[],
  newPositions: Vec3[]
): boolean {
  const cell = adhereCell(state, sharedNodeIds, newPositions);
  if (!cell) return false;
  assignTypesFromBasis(state);
  return true;
}
