/**
 * Tensegrity Morphogenesis Engine — proper Class-1 tower (Snelson pattern)
 *
 * A true Class-1 tensegrity has:
 *   - Every node touches EXACTLY 1 strut
 *   - Cables form a CONNECTED network (the "continuum")
 *   - Struts are DISCONTINUOUS (no two struts share a node)
 *   - The struts "float" inside the cable network
 *
 * Snelson Tower construction:
 *   - Each "layer" = 3-strut Triplex prism
 *   - Each layer has its OWN 6 nodes (NO sharing with adjacent layers)
 *   - Layers interlace in space with ~50% overlap in z
 *   - Adjacent layers are connected ONLY by cables between
 *     the upper ring of layer N and the lower ring of layer N+1
 *   - Twist direction alternates between layers for stability
 *
 * Each layer is self-stressed independently; layers are then stitched
 * via interface cables. The full structure's force densities are
 * recomputed from the combined equilibrium matrix nullspace.
 */

import { Vec3, MorphogenesisState } from './types';
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

function nodePos(state: MorphogenesisState, id: number): Vec3 {
  return state.graph.nodes.find(n => n.id === id)?.pos || [0, 0, 0];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}

function addEdge(state: MorphogenesisState, a: number, b: number, type: 'strut' | 'cable'): number {
  const id = state.graph.nextEdgeId++;
  state.graph.edges.push({
    id, n: [a, b], type,
    forceDensity: 0, // computed later from nullspace
    typeLocked: true, // user's design intent
  });
  return id;
}

// ─── Triplex Layer ───────────────────────────────────────────────

interface TriplexLayer {
  bottomIds: number[];  // 3 node ids
  topIds: number[];     // 3 node ids
  strutIds: number[];   // 3 strut edge ids
  zBottom: number;
  zTop: number;
  twistAngle: number;   // rotation of top ring relative to bottom (radians)
  radius: number;
}

/**
 * Create an independent Triplex (3-strut tensegrity prism) at a given
 * position. All 6 nodes are new; the layer has 3 struts + 9 cables.
 *
 * Returns the layer info for later cable-stitching with adjacent layers.
 */
function createTriplexLayer(
  state: MorphogenesisState,
  cx: number,
  cy: number,
  zBottom: number,
  zTop: number,
  radius: number,
  twistAngle: number,   // top ring rotated by this angle (π/6 = stable)
  baseAngle: number = 0 // rotation of the bottom ring
): TriplexLayer {
  const N = 3;
  const bottomIds: number[] = [];
  const topIds: number[] = [];

  // Bottom ring: 3 nodes on a circle
  for (let i = 0; i < N; i++) {
    const theta = baseAngle + (2 * Math.PI * i) / N;
    bottomIds.push(addNode(state, [
      cx + radius * Math.cos(theta),
      cy + radius * Math.sin(theta),
      zBottom,
    ]));
  }

  // Top ring: 3 nodes rotated by twistAngle
  for (let i = 0; i < N; i++) {
    const theta = baseAngle + (2 * Math.PI * i) / N + twistAngle;
    topIds.push(addNode(state, [
      cx + radius * Math.cos(theta),
      cy + radius * Math.sin(theta),
      zTop,
    ]));
  }

  // Struts: 3 compression plates
  const strutIds: number[] = [];
  for (let i = 0; i < N; i++) {
    strutIds.push(addEdge(state, bottomIds[i], topIds[i], 'strut'));
  }

  // Bottom ring cables
  for (let i = 0; i < N; i++) {
    addEdge(state, bottomIds[i], bottomIds[(i + 1) % N], 'cable');
  }

  // Top ring cables
  for (let i = 0; i < N; i++) {
    addEdge(state, topIds[i], topIds[(i + 1) % N], 'cable');
  }

  // Diagonal cables (lateral tensioning within the prism)
  for (let i = 0; i < N; i++) {
    addEdge(state, bottomIds[i], topIds[(i + 1) % N], 'cable');
  }

  return { bottomIds, topIds, strutIds, zBottom, zTop, twistAngle, radius };
}

/**
 * Stitch two adjacent layers together with interface cables.
 * The upper ring of layer A connects to the lower ring of layer B
 * via cables (NO node sharing, preserving Class-1).
 *
 * For each upper node in layer A, connect to the 2 closest lower
 * nodes in layer B. This creates a triangulated cable interface.
 */
function stitchLayers(
  state: MorphogenesisState,
  layerA: TriplexLayer,
  layerB: TriplexLayer
): void {
  for (const aId of layerA.topIds) {
    const aPos = nodePos(state, aId);
    const distances = layerB.bottomIds.map(bId => ({
      id: bId,
      d: dist3(aPos, nodePos(state, bId)),
    }));
    distances.sort((a, b) => a.d - b.d);
    // Connect to 2 closest lower ring nodes
    for (let k = 0; k < Math.min(2, distances.length); k++) {
      addEdge(state, aId, distances[k].id, 'cable');
    }
  }
  // Also add reverse connections for better triangulation
  for (const bId of layerB.bottomIds) {
    const bPos = nodePos(state, bId);
    const closest = layerA.topIds
      .map(aId => ({ id: aId, d: dist3(bPos, nodePos(state, aId)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (closest) {
      // Check if not already connected
      const exists = state.graph.edges.some(e =>
        (e.n[0] === bId && e.n[1] === closest.id) ||
        (e.n[0] === closest.id && e.n[1] === bId)
      );
      if (!exists) addEdge(state, bId, closest.id, 'cable');
    }
  }
}

// ─── Auto-Grow: Snelson Tensegrity Tower ────────────────────────

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
  const { baseRadius = 1.2, spread = 0.3 } = options;

  // Layer parameters
  const layerHeight = 2.0;
  const overlap = 0.35;  // z-overlap between layers (0 = stacked, 0.5 = 50% interleaved)
  const layerSpacing = layerHeight * (1 - overlap);
  const twistAngle = Math.PI / 6; // 30° twist (stable Triplex)

  const layers: TriplexLayer[] = [];

  for (let i = 0; i < numCells; i++) {
    // Small lateral offset for organic variation
    const cx = (Math.random() - 0.5) * spread;
    const cy = (Math.random() - 0.5) * spread;
    const zBottom = i * layerSpacing;
    const zTop = zBottom + layerHeight;
    const radius = baseRadius * (0.9 + Math.random() * 0.2);

    // Alternate twist direction for stability (Snelson pattern)
    const twist = (i % 2 === 0) ? twistAngle : -twistAngle;

    // Alternate base rotation so top/bottom rings of adjacent layers
    // are rotated relative to each other, encouraging cross-cables
    const baseAngle = (i % 2 === 0) ? 0 : Math.PI / 3;

    const layer = createTriplexLayer(state, cx, cy, zBottom, zTop, radius, twist, baseAngle);
    layers.push(layer);

    // Stitch to previous layer
    if (i > 0) {
      stitchLayers(state, layers[i - 1], layer);
    }
  }

  // Compute force densities from the combined equilibrium matrix
  computeForceDensities(state);

  return state.graph.nodes.length > 0;
}

// ─── Compute force densities from global equilibrium nullspace ─

function computeForceDensities(state: MorphogenesisState): void {
  const { nodes, edges } = state.graph;
  if (edges.length === 0 || nodes.length === 0) return;

  const m = edges.length, n = nodes.length;
  const nodeIdxMap = new Map(nodes.map((nd, i) => [nd.id, i]));

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
    const ii = nodeIdxMap.get(ni)!, ij = nodeIdxMap.get(nj)!;
    A[3 * ii][e] = dx / len; A[3 * ii + 1][e] = dy / len; A[3 * ii + 2][e] = dz / len;
    A[3 * ij][e] = -dx / len; A[3 * ij + 1][e] = -dy / len; A[3 * ij + 2][e] = -dz / len;
  }

  const basis = findNullspaceBasis(A);
  state.stressBasis = basis;
  if (basis.length === 0) return;

  // Find a linear combination of basis vectors that matches the
  // locked strut/cable type assignment (struts negative, cables positive).
  const k = basis.length;
  const targetSigns = edges.map(e => e.type === 'strut' ? -1 : 1);

  const scoreCombo = (coeffs: number[]): number => {
    const t = new Array(m).fill(0);
    for (let i = 0; i < k; i++)
      for (let e = 0; e < m; e++)
        t[e] += coeffs[i] * basis[i][e];
    let score = 0;
    for (let e = 0; e < m; e++) {
      const mag = Math.abs(t[e]);
      if (mag < 1e-10) continue;
      const sign = t[e] > 0 ? 1 : -1;
      score += sign === targetSigns[e] ? mag : -mag;
    }
    return score;
  };

  let bestCoeffs = new Array(k).fill(0);
  bestCoeffs[0] = 1;
  let bestScore = -Infinity;

  const nTrials = k <= 10 ? (1 << k) : 500;
  for (let trial = 0; trial < nTrials; trial++) {
    const coeffs = new Array(k);
    if (k <= 10) {
      for (let i = 0; i < k; i++) coeffs[i] = ((trial >> i) & 1) ? 1 : -1;
    } else {
      for (let i = 0; i < k; i++) coeffs[i] = (Math.random() - 0.5) * 2;
    }
    const s = scoreCombo(coeffs);
    if (s > bestScore) { bestScore = s; bestCoeffs = [...coeffs]; }
  }

  // Apply the best combination
  const t = new Array(m).fill(0);
  for (let i = 0; i < k; i++)
    for (let e = 0; e < m; e++)
      t[e] += bestCoeffs[i] * basis[i][e];

  // Normalize
  let maxQ = 0;
  for (let e = 0; e < m; e++) maxQ = Math.max(maxQ, Math.abs(t[e] / lengths[e]));
  const scale = maxQ > 1e-12 ? 1 / maxQ : 1;

  for (let e = 0; e < m; e++) {
    edges[e].forceDensity = (t[e] / lengths[e]) * scale;
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

// ─── Legacy API ──────────────────────────────────────────────────

export function seed(state: MorphogenesisState, _points: Vec3[]): boolean {
  createTriplexLayer(state, 0, 0, 0, 2.0, 1.2, Math.PI / 6);
  computeForceDensities(state);
  return true;
}

export function grow(
  _state: MorphogenesisState,
  _sharedNodeIds: number[],
  _newPositions: Vec3[]
): boolean {
  return false;
}
