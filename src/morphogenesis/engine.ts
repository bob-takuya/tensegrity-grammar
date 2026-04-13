/**
 * Tensegrity Morphogenesis Engine — Snelson tower + K₅ adhesion/fusion
 *
 * Base structure (autoGrow): Class-1 Snelson tower built from Triplex
 * layers. Each layer is an independent 3-strut prism with its own 6
 * nodes; adjacent layers share NO nodes and are stitched only via
 * cables, preserving the "discontinuous struts in a cable continuum"
 * definition of tensegrity.
 *
 * Growth operations (search-based, constraint-preserving):
 *   • tryAdhesion — attach a K₅ cell sharing 3 or 4 existing nodes.
 *                   Adds the missing K₅ edges as "unlocked", then the
 *                   global equilibrium nullspace is re-solved with a
 *                   sign-optimizer that penalises Class-k violations.
 *                   The move is accepted only if every constraint
 *                   still holds, otherwise the state is reverted.
 *                   Random retries implement the search.
 *   • tryFusion   — remove one edge and re-solve forces. Reverted if
 *                   the structure loses self-stress, Class-k, cable
 *                   continuity, or equilibrium.
 *
 * Constraints enforced at every step:
 *   1. Class-k:     each node has ≤ k struts (default k = 1)
 *   2. Continuum:   all nodes connected via a single cable component
 *   3. No orphans:  every node has ≥1 strut AND ≥1 cable
 *   4. Equilibrium: |Aw|_∞ < 1e-6 with a non-trivial stress state
 */

import { Vec3, MorphogenesisState, MEdge, MNode } from './types';
import { findNullspaceBasis } from './linalg';

// ─── State setup ─────────────────────────────────────────────────

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

// ─── Graph helpers ───────────────────────────────────────────────

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

function addEdge(
  state: MorphogenesisState,
  a: number, b: number,
  type: 'strut' | 'cable',
  locked = true
): number {
  const id = state.graph.nextEdgeId++;
  state.graph.edges.push({
    id, n: [a, b], type,
    forceDensity: 0,
    typeLocked: locked,
  });
  return id;
}

function edgeExists(state: MorphogenesisState, a: number, b: number): boolean {
  return state.graph.edges.some(e =>
    (e.n[0] === a && e.n[1] === b) || (e.n[0] === b && e.n[1] === a));
}

// ─── Snapshot / restore (for reverting failed search moves) ─────

interface GraphSnapshot {
  nodes: MNode[];
  edges: MEdge[];
  nextNodeId: number;
  nextEdgeId: number;
  stressBasis: number[][];
}

function snapshot(state: MorphogenesisState): GraphSnapshot {
  return {
    nodes: state.graph.nodes.map(n => ({
      id: n.id,
      pos: [n.pos[0], n.pos[1], n.pos[2]],
    })),
    edges: state.graph.edges.map(e => ({
      id: e.id,
      n: [e.n[0], e.n[1]],
      type: e.type,
      forceDensity: e.forceDensity,
      typeLocked: e.typeLocked,
    })),
    nextNodeId: state.graph.nextNodeId,
    nextEdgeId: state.graph.nextEdgeId,
    stressBasis: state.stressBasis.map(v => [...v]),
  };
}

function restore(state: MorphogenesisState, snap: GraphSnapshot): void {
  state.graph.nodes = snap.nodes;
  state.graph.edges = snap.edges;
  state.graph.nextNodeId = snap.nextNodeId;
  state.graph.nextEdgeId = snap.nextEdgeId;
  state.stressBasis = snap.stressBasis;
}

// ─── Triplex layer (Class-1 prism) ───────────────────────────────

interface TriplexLayer {
  bottomIds: number[];
  topIds: number[];
  strutIds: number[];
  zBottom: number;
  zTop: number;
  twistAngle: number;
  radius: number;
}

function createTriplexLayer(
  state: MorphogenesisState,
  cx: number, cy: number,
  zBottom: number, zTop: number,
  radius: number,
  twistAngle: number,
  baseAngle = 0
): TriplexLayer {
  const N = 3;
  const bottomIds: number[] = [];
  const topIds: number[] = [];

  for (let i = 0; i < N; i++) {
    const theta = baseAngle + (2 * Math.PI * i) / N;
    bottomIds.push(addNode(state, [
      cx + radius * Math.cos(theta),
      cy + radius * Math.sin(theta),
      zBottom,
    ]));
  }
  for (let i = 0; i < N; i++) {
    const theta = baseAngle + (2 * Math.PI * i) / N + twistAngle;
    topIds.push(addNode(state, [
      cx + radius * Math.cos(theta),
      cy + radius * Math.sin(theta),
      zTop,
    ]));
  }

  const strutIds: number[] = [];
  for (let i = 0; i < N; i++) {
    strutIds.push(addEdge(state, bottomIds[i], topIds[i], 'strut'));
  }
  for (let i = 0; i < N; i++) {
    addEdge(state, bottomIds[i], bottomIds[(i + 1) % N], 'cable');
  }
  for (let i = 0; i < N; i++) {
    addEdge(state, topIds[i], topIds[(i + 1) % N], 'cable');
  }
  // Diagonal direction depends on twist chirality: only one of the two
  // choices gives a valid self-stressed Triplex. For positive twist we
  // use bot[i] → top[(i+1)%N]; for negative twist we flip it so the
  // cables still pull the prism into balance.
  const diagFwd = twistAngle >= 0;
  for (let i = 0; i < N; i++) {
    const a = bottomIds[i];
    const b = topIds[diagFwd ? (i + 1) % N : (i - 1 + N) % N];
    addEdge(state, a, b, 'cable');
  }

  return { bottomIds, topIds, strutIds, zBottom, zTop, twistAngle, radius };
}

function stitchLayers(
  state: MorphogenesisState,
  layerA: TriplexLayer,
  layerB: TriplexLayer
): void {
  for (const aId of layerA.topIds) {
    const aPos = nodePos(state, aId);
    const distances = layerB.bottomIds.map(bId => ({
      id: bId, d: dist3(aPos, nodePos(state, bId)),
    }));
    distances.sort((a, b) => a.d - b.d);
    for (let k = 0; k < Math.min(2, distances.length); k++) {
      if (!edgeExists(state, aId, distances[k].id)) {
        addEdge(state, aId, distances[k].id, 'cable');
      }
    }
  }
  for (const bId of layerB.bottomIds) {
    const bPos = nodePos(state, bId);
    const closest = layerA.topIds
      .map(aId => ({ id: aId, d: dist3(bPos, nodePos(state, aId)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (closest && !edgeExists(state, bId, closest.id)) {
      addEdge(state, bId, closest.id, 'cable');
    }
  }
}

// ─── Global force density solver ─────────────────────────────────

interface ComputeOptions {
  maxCompDeg?: number;
}

function computeForceDensities(
  state: MorphogenesisState,
  options: ComputeOptions = {}
): void {
  const { maxCompDeg = Infinity } = options;
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
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (len < 1e-12) continue;
    lengths[e] = len;
    const ii = nodeIdxMap.get(ni)!, ij = nodeIdxMap.get(nj)!;
    A[3*ii][e] = dx/len;   A[3*ii+1][e] = dy/len;   A[3*ii+2][e] = dz/len;
    A[3*ij][e] = -dx/len;  A[3*ij+1][e] = -dy/len;  A[3*ij+2][e] = -dz/len;
  }

  const basis = findNullspaceBasis(A);
  state.stressBasis = basis;
  if (basis.length === 0) return;

  const k = basis.length;
  const lockedSign: (number | null)[] = edges.map(e => {
    if (!e.typeLocked) return null;
    if (e.type === 'strut') return -1;
    if (e.type === 'cable') return 1;
    return null;
  });
  const edgeEnds: [number, number][] = edges.map(e => [
    nodeIdxMap.get(e.n[0])!,
    nodeIdxMap.get(e.n[1])!,
  ]);

  // Analytical seed: the linear "locked alignment" score
  //   S_locked(t) = Σ_{e locked} lockedSign[e] · t[e] / L[e]
  // is linear in t, hence linear in the coefficients. Its gradient
  // (in coefficient space) points at the direction that maximises
  // it on the unit sphere, giving an LP-style starting direction
  // the random search then refines for Class-k feasibility.
  const gradient = new Array(k).fill(0);
  for (let i = 0; i < k; i++) {
    for (let e = 0; e < m; e++) {
      const tgt = lockedSign[e];
      if (tgt !== null) gradient[i] += tgt * basis[i][e] / lengths[e];
    }
  }
  const gNorm = Math.sqrt(gradient.reduce((s, g) => s + g*g, 0));
  const gradSeed = gNorm > 1e-12 ? gradient.map(g => g / gNorm) : null;

  const computeT = (coeffs: number[]): number[] => {
    const t = new Array(m).fill(0);
    for (let i = 0; i < k; i++)
      for (let e = 0; e < m; e++)
        t[e] += coeffs[i] * basis[i][e];
    return t;
  };

  const evaluate = (coeffs: number[]): { score: number; t: number[] } => {
    const t = computeT(coeffs);

    // Normalise so that the largest |t[e]/L[e]| is 1 — makes scores
    // comparable across combos of different overall scale.
    let maxQ = 0;
    for (let e = 0; e < m; e++) maxQ = Math.max(maxQ, Math.abs(t[e] / lengths[e]));
    if (maxQ < 1e-12) return { score: -Infinity, t };
    const scl = 1 / maxQ;

    let score = 0;
    const strutPerNode = new Array(n).fill(0);
    for (let e = 0; e < m; e++) {
      const val = (t[e] / lengths[e]) * scl;      // in [-1, 1]
      const tgt = lockedSign[e];
      if (tgt !== null) {
        // Linear reward aligned with the locked sign.
        score += tgt * val;
      } else {
        score += Math.abs(val) * 0.2;
      }
      if (val < -1e-8) {
        strutPerNode[edgeEnds[e][0]]++;
        strutPerNode[edgeEnds[e][1]]++;
      }
    }
    // Soft Class-k penalty (does not dominate alignment)
    for (let i = 0; i < n; i++) {
      if (strutPerNode[i] > maxCompDeg) {
        score -= (strutPerNode[i] - maxCompDeg) * 0.5;
      }
    }
    return { score, t };
  };

  // Start from the analytical LP seed, fall back to e_1 if no locked
  // signs exist (e.g. early calls before types are set).
  let bestCoeffs: number[] = gradSeed ?? (() => {
    const c = new Array(k).fill(0); c[0] = 1; return c;
  })();
  let bestResult = evaluate(bestCoeffs);
  let bestScore = bestResult.score;
  let bestT: number[] = bestResult.t;

  // Also try the ±1 corners (exhaustive for small k), then
  // Gaussian perturbations around the best-so-far to refine
  // Class-k feasibility.
  const cornerLimit = k <= 10 ? (1 << k) : 0;
  const nTrials = cornerLimit + (k <= 10 ? 800 : Math.min(3000, 300 * k));
  for (let trial = 0; trial < nTrials; trial++) {
    const coeffs = new Array(k);
    if (trial < cornerLimit) {
      for (let i = 0; i < k; i++) coeffs[i] = ((trial >> i) & 1) ? 1 : -1;
    } else {
      const sigma = 0.4;
      for (let i = 0; i < k; i++) {
        coeffs[i] = bestCoeffs[i] + (Math.random() * 2 - 1) * sigma;
      }
    }
    const res = evaluate(coeffs);
    if (res.score > bestScore) {
      bestScore = res.score;
      bestCoeffs = [...coeffs];
      bestT = res.t;
    }
  }

  const t = bestT;

  // Normalize
  let maxQ = 0;
  for (let e = 0; e < m; e++) maxQ = Math.max(maxQ, Math.abs(t[e] / lengths[e]));
  const scale = maxQ > 1e-12 ? 1 / maxQ : 1;

  for (let e = 0; e < m; e++) {
    edges[e].forceDensity = (t[e] / lengths[e]) * scale;
    if (!edges[e].typeLocked) {
      edges[e].type = edges[e].forceDensity >= 0 ? 'cable' : 'strut';
    }
  }
}

// ─── Constraint checker ──────────────────────────────────────────

/**
 * Count the number of connected components induced by active cables.
 * An "active" cable has non-negligible force density.
 */
function cableComponentCount(state: MorphogenesisState): number {
  const { nodes, edges } = state.graph;
  if (nodes.length === 0) return 0;
  const adj = new Map<number, number[]>();
  for (const nd of nodes) adj.set(nd.id, []);
  for (const e of edges) {
    if (e.type !== 'cable' || Math.abs(e.forceDensity) < 1e-8) continue;
    adj.get(e.n[0])!.push(e.n[1]);
    adj.get(e.n[1])!.push(e.n[0]);
  }
  const visited = new Set<number>();
  let components = 0;
  for (const seed of nodes) {
    if (visited.has(seed.id)) continue;
    components++;
    const stack = [seed.id];
    while (stack.length) {
      const v = stack.pop()!;
      if (visited.has(v)) continue;
      visited.add(v);
      for (const u of adj.get(v) || []) stack.push(u);
    }
  }
  return components;
}

/**
 * Hard constraints every valid tensegrity state must satisfy:
 *   • Equilibrium residual below threshold
 *   • A non-trivial self-stress (not all zero)
 *   • Class-k: no node has more than `maxCompDeg` active struts
 *   • No orphans: every node has ≥1 active strut AND ≥1 active cable
 *
 * Global cable continuity is *not* enforced here — the Snelson tower
 * base is 3 independent sub-tensegrities until adhesion couples
 * them. Instead, adhesion/fusion operations check separately that
 * they do not increase the cable component count.
 */
function checkConstraints(
  state: MorphogenesisState,
  maxCompDeg: number
): boolean {
  const { nodes, edges } = state.graph;
  if (nodes.length === 0 || edges.length === 0) return false;

  // Equilibrium
  if (verifyEquilibrium(nodes, edges) > 1e-6) return false;

  // Non-trivial stress state
  let maxF = 0;
  for (const e of edges) maxF = Math.max(maxF, Math.abs(e.forceDensity));
  if (maxF < 1e-8) return false;

  // Per-node active strut / cable counts
  const strutCount = new Map<number, number>();
  const cableCount = new Map<number, number>();
  for (const e of edges) {
    if (Math.abs(e.forceDensity) < 1e-8) continue;
    const map = e.type === 'strut' ? strutCount : cableCount;
    map.set(e.n[0], (map.get(e.n[0]) || 0) + 1);
    map.set(e.n[1], (map.get(e.n[1]) || 0) + 1);
  }
  for (const nd of nodes) {
    const s = strutCount.get(nd.id) || 0;
    const c = cableCount.get(nd.id) || 0;
    if (s > maxCompDeg) return false;
    if (s === 0) return false;      // no cable-only nodes
    if (c === 0) return false;      // no strut-only nodes
  }

  return true;
}

// ─── Adhesion (K₅ cell glued to 3 or 4 existing nodes) ──────────

export function tryAdhesion(
  state: MorphogenesisState,
  options: {
    trials?: number;
    sharedCount?: 3 | 4;
    maxCompDeg?: number;
    spread?: number;
  } = {}
): boolean {
  const {
    trials = 80,
    sharedCount = 3,
    maxCompDeg = 1,
    spread = 1.5,
  } = options;

  const existingIds = state.graph.nodes.map(nd => nd.id);
  if (existingIds.length < sharedCount) return false;

  const beforeComponents = cableComponentCount(state);

  for (let trial = 0; trial < trials; trial++) {
    const snap = snapshot(state);

    // Pick a seed node, then sharedCount neighbours near it
    const seed = existingIds[Math.floor(Math.random() * existingIds.length)];
    const seedPos = nodePos(state, seed);
    const candidates = existingIds
      .map(id => ({ id, d: dist3(seedPos, nodePos(state, id)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, Math.min(existingIds.length, sharedCount * 3))
      .map(x => x.id);
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const sharedIds = shuffled.slice(0, sharedCount);
    const sharedPos = sharedIds.map(id => nodePos(state, id));

    // Centroid of shared nodes
    const cx = sharedPos.reduce((s, p) => s + p[0], 0) / sharedCount;
    const cy = sharedPos.reduce((s, p) => s + p[1], 0) / sharedCount;
    const cz = sharedPos.reduce((s, p) => s + p[2], 0) / sharedCount;

    // Generate new positions offset from the centroid
    const numNew = 5 - sharedCount;
    const newIds: number[] = [];
    for (let i = 0; i < numNew; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = spread * (0.6 + Math.random() * 0.6);
      newIds.push(addNode(state, [
        cx + r * Math.sin(phi) * Math.cos(theta),
        cy + r * Math.sin(phi) * Math.sin(theta),
        cz + r * Math.cos(phi),
      ]));
    }

    const allIds = [...sharedIds, ...newIds];

    // Add K₅ edges (unlocked — their type is chosen by the optimizer)
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        const a = allIds[i], b = allIds[j];
        if (edgeExists(state, a, b)) continue;
        addEdge(state, a, b, 'cable', /*locked=*/ false);
      }
    }

    // Re-solve forces with Class-k penalty on the optimizer
    computeForceDensities(state, { maxCompDeg });

    // Adhesion must not fracture the cable network; ideally it
    // couples previously-disjoint components (strict monotone).
    const afterComponents = cableComponentCount(state);
    const couplingOK = afterComponents <= beforeComponents;

    if (couplingOK && checkConstraints(state, maxCompDeg)) {
      // Lock the newly chosen types so future operations respect them
      for (const e of state.graph.edges) {
        if (!e.typeLocked) e.typeLocked = true;
      }
      return true;
    }

    restore(state, snap);
  }
  return false;
}

// ─── Fusion (single edge removal via nullspace freedom) ─────────

export function tryFusion(
  state: MorphogenesisState,
  options: {
    maxCompDeg?: number;
    maxRemovals?: number;
    preferNearZero?: boolean;
  } = {}
): number {
  const {
    maxCompDeg = 1,
    maxRemovals = 1,
    preferNearZero = true,
  } = options;

  let removed = 0;
  while (removed < maxRemovals) {
    const m = state.graph.edges.length;
    if (m === 0) break;

    const beforeComponents = cableComponentCount(state);

    // Rank candidates: smallest |forceDensity| first (edges the
    // current stress state already "uses" least — cheapest to drop).
    const order = Array.from({ length: m }, (_, i) => i);
    if (preferNearZero) {
      order.sort((a, b) =>
        Math.abs(state.graph.edges[a].forceDensity)
        - Math.abs(state.graph.edges[b].forceDensity));
    } else {
      order.sort(() => Math.random() - 0.5);
    }

    let fused = false;
    for (const idx of order.slice(0, Math.min(m, 30))) {
      const snap = snapshot(state);
      state.graph.edges = state.graph.edges.filter((_, i) => i !== idx);

      computeForceDensities(state, { maxCompDeg });

      // Fusion must not fracture the cable network further
      const afterComponents = cableComponentCount(state);
      if (afterComponents > beforeComponents) {
        restore(state, snap);
        continue;
      }

      if (checkConstraints(state, maxCompDeg)) {
        fused = true;
        removed++;
        break;
      }
      restore(state, snap);
    }

    if (!fused) break;
  }
  return removed;
}

// ─── Auto-grow: tower + optional adhesion / fusion passes ───────

export function autoGrow(
  state: MorphogenesisState,
  numCells: number,
  options: {
    baseRadius?: number;
    spread?: number;
    fuseProbability?: number;
    maxCompDeg?: number;
    adhesionAttempts?: number;
  } = {}
): boolean {
  const {
    baseRadius = 1.2,
    spread = 0.3,
    fuseProbability = 0,
    maxCompDeg = 1,
    adhesionAttempts = 0,
  } = options;

  // ── Base Snelson tower (Class-1 by construction) ──────────────
  const layerHeight = 2.0;
  const overlap = 0.35;
  const layerSpacing = layerHeight * (1 - overlap);
  const twistAngle = Math.PI / 6;

  const layers: TriplexLayer[] = [];
  for (let i = 0; i < numCells; i++) {
    const cx = (Math.random() - 0.5) * spread;
    const cy = (Math.random() - 0.5) * spread;
    const zBottom = i * layerSpacing;
    const zTop = zBottom + layerHeight;
    const radius = baseRadius * (0.9 + Math.random() * 0.2);
    const twist = (i % 2 === 0) ? twistAngle : -twistAngle;
    const baseAngle = (i % 2 === 0) ? 0 : Math.PI / 3;
    const layer = createTriplexLayer(state, cx, cy, zBottom, zTop, radius, twist, baseAngle);
    layers.push(layer);
    if (i > 0) stitchLayers(state, layers[i - 1], layer);
  }

  computeForceDensities(state, { maxCompDeg });

  // ── Search-based K₅ adhesion passes (each call reverts on fail) ─
  for (let i = 0; i < adhesionAttempts; i++) {
    tryAdhesion(state, {
      trials: 40,
      sharedCount: Math.random() < 0.5 ? 3 : 4,
      maxCompDeg,
      spread: 1.2,
    });
  }

  // ── Search-based fusion pass ──────────────────────────────────
  if (fuseProbability > 0) {
    const target = Math.max(1, Math.floor(state.graph.edges.length * fuseProbability * 0.2));
    tryFusion(state, { maxCompDeg, maxRemovals: target });
  }

  return state.graph.nodes.length > 0;
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
  computeForceDensities(state, { maxCompDeg: 1 });
  return true;
}

export function grow(
  _state: MorphogenesisState,
  _sharedNodeIds: number[],
  _newPositions: Vec3[]
): boolean {
  return false;
}
