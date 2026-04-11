/**
 * Cellular Morphogenesis for Tensegrity Structures
 *
 * Based on: Aloui, Orden, Rhode-Barbarigos (2018-2019)
 *
 * Growth = stacking prism cells. Each cell shares its bottom face
 * (3 nodes + 3 cables) with the top face of the previous cell.
 *
 * The key tracking data: `topFace` — the 3 node IDs of the current
 * top ring. Each ADHESION uses these as the shared face, then
 * updates topFace to the new top ring.
 */

import { DiagramData, DiagramNode, DiagramEdge, ElementType } from '../types';
import { generateId } from '../utils/id';
import { solve as solveLinalg, findNullspaceBasis } from '../engine/linalg';

// ─── Re-export types ─────────────────────────────────────────────

export interface InterimForce { id: string; nodeId: string; fx: number; fy: number; }
export type EntropyRate = -1 | 0 | 1;
export interface FeasibilityDomain { type: 'point' | 'line' | 'area'; origin?: { x: number; y: number }; direction?: { x: number; y: number }; point?: { x: number; y: number }; }
export interface ForceGrammarState { active: boolean; interimForces: InterimForce[]; selectedForceId: string | null; feasibilityDomain: FeasibilityDomain | null; isComplete: boolean; }

// ─── Helpers ─────────────────────────────────────────────────────

let _plateThickness = 3;
function cloneDiagram(d: DiagramData): DiagramData {
  return { nodes: d.nodes.map(n => ({ ...n, externalForce: { ...n.externalForce } })), edges: d.edges.map(e => ({ ...e })) };
}
function hasEdge(edges: DiagramEdge[], a: string, b: string): boolean {
  return edges.some(e => (e.source === a && e.target === b) || (e.source === b && e.target === a));
}
function makeNode(x: number, y: number, z: number): DiagramNode {
  return { id: generateId('n'), x, y, z, support: 'free', externalForce: { x: 0, y: 0 } };
}
function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return { id: generateId('e'), source: src, target: tgt, elementType: type, plateWidth: 0.2 + Math.random() * 0.2, plateThickness: _plateThickness, plateAngle: Math.random() * 360 };
}
function rand(min: number, max: number): number { return min + Math.random() * (max - min); }
function plateEndpoints(d: DiagramData): string[] {
  const ids = new Set<string>();
  for (const e of d.edges) if (e.elementType === 'compression') { ids.add(e.source); ids.add(e.target); }
  return [...ids];
}

// ═════════════════════════════════════════════════════════════════
// FORCE DENSITY FORM-FINDING
// ═════════════════════════════════════════════════════════════════

/**
 * Solve for x,y positions of free nodes via force density method.
 * @param freeIds  Specific nodes to solve. All others are anchored.
 *                 If omitted, anchors = lowest-z plate endpoints.
 */
function formFindXY(d: DiagramData, freeIds?: string[]): boolean {
  let anchorIds: Set<string>;

  if (freeIds && freeIds.length > 0) {
    const freeSet = new Set(freeIds);
    anchorIds = new Set(d.nodes.filter(n => !freeSet.has(n.id)).map(n => n.id));
  } else {
    const pEnds = new Set(plateEndpoints(d));
    if (pEnds.size === 0) return false;
    const peNodes = d.nodes.filter(n => pEnds.has(n.id)).sort((a, b) => a.z - b.z);
    if (peNodes.length < 3) return false;
    const minZ = peNodes[0].z;
    const anchors = peNodes.filter(n => Math.abs(n.z - minZ) < 0.1);
    if (anchors.length < 2) return false;
    anchorIds = new Set(anchors.map(n => n.id));
  }

  const anchorList: DiagramNode[] = [];
  const freeList: DiagramNode[] = [];
  for (const n of d.nodes) {
    if (anchorIds.has(n.id)) anchorList.push(n); else freeList.push(n);
  }
  if (freeList.length === 0) return true;

  const allNodes = [...anchorList, ...freeList];
  const nodeIdx = new Map(allNodes.map((n, i) => [n.id, i]));
  const nA = anchorList.length, nF = freeList.length, nTotal = nA + nF;

  const D: number[][] = Array.from({ length: nTotal }, () => new Array(nTotal).fill(0));
  for (const e of d.edges) {
    const i = nodeIdx.get(e.source), j = nodeIdx.get(e.target);
    if (i === undefined || j === undefined) continue;
    const q = e.elementType === 'compression' ? -1 : 1;
    D[i][i] += q; D[j][j] += q; D[i][j] -= q; D[j][i] -= q;
  }

  const D_ff: number[][] = Array.from({ length: nF }, (_, i) => Array.from({ length: nF }, (_, j) => D[nA + i][nA + j]));
  const D_fa: number[][] = Array.from({ length: nF }, (_, i) => Array.from({ length: nA }, (_, j) => D[nA + i][j]));
  const aX = anchorList.map(n => n.x), aY = anchorList.map(n => n.y);

  const rhsX = new Array(nF).fill(0), rhsY = new Array(nF).fill(0);
  for (let i = 0; i < nF; i++) for (let j = 0; j < nA; j++) {
    rhsX[i] -= D_fa[i][j] * aX[j]; rhsY[i] -= D_fa[i][j] * aY[j];
  }

  let fX = solveLinalg(D_ff, rhsX), fY = solveLinalg(D_ff, rhsY);
  if (!fX || !fY) {
    // D_ff is singular. Replace dependent rows with centroid constraints.
    // For each connected component of free nodes, add one constraint.
    const D_reg = D_ff.map(row => [...row]);
    const rX = [...rhsX], rY = [...rhsY];
    // Replace last row with centroid constraint: sum(x_i) = sum(anchor_x)
    const cX = aX.reduce((s, v) => s + v, 0) / nA;
    const cY = aY.reduce((s, v) => s + v, 0) / nA;
    for (let j = 0; j < nF; j++) D_reg[nF - 1][j] = 1;
    rX[nF - 1] = cX * nF;
    rY[nF - 1] = cY * nF;
    fX = solveLinalg(D_reg, rX); fY = solveLinalg(D_reg, rY);

    // If still singular, also replace second-to-last row
    if (!fX || !fY) {
      for (let j = 0; j < nF; j++) D_reg[nF - 2][j] = (j < nF / 2) ? 1 : 0;
      rX[nF - 2] = cX * Math.floor(nF / 2);
      rY[nF - 2] = cY * Math.floor(nF / 2);
      fX = solveLinalg(D_reg, rX); fY = solveLinalg(D_reg, rY);
    }
  }
  if (!fX || !fY) return false;
  for (let i = 0; i < nF; i++) if (!isFinite(fX[i]) || !isFinite(fY[i])) return false;

  // Apply x, y from form-finding. z stays at set height (design parameter).
  for (let i = 0; i < nF; i++) { freeList[i].x = fX[i]; freeList[i].y = fY[i]; }
  return true;
}

// ═════════════════════════════════════════════════════════════════
// FORM-FIND A PRISM LAYER (correct force densities)
// ═════════════════════════════════════════════════════════════════

/**
 * Solve for top ring x,y positions using the partitioned force
 * density method with centroid constraint.
 *
 * D = C^T Q C, partitioned into [D_bb, D_bt; D_tb, D_tt].
 * Solve D_tt * x_t = -D_tb * x_b with centroid(x_t) = 0.
 *
 * This gives positions where the equilibrium matrix A has a
 * non-trivial nullspace (self-stress), verified experimentally.
 */
function formFindPrismLayer(
  d: DiagramData,
  bottomIds: string[], topIds: string[], N: number
): boolean {
  if (N < 3) return false;

  const qStrut = -1, qRing = 0.5, qDiag = 1.0;

  // Build D (2N × 2N): indices 0..N-1 = bottom, N..2N-1 = top
  const nN = 2 * N;
  const L: number[][] = Array.from({ length: nN }, () => new Array(nN).fill(0));
  const addQ = (i: number, j: number, q: number) => {
    L[i][i] += q; L[j][j] += q; L[i][j] -= q; L[j][i] -= q;
  };
  for (let k = 0; k < N; k++) {
    addQ(k, N + k, qStrut);
    addQ(k, (k + 1) % N, qRing);
    addQ(N + k, N + (k + 1) % N, qRing);
    addQ(k, N + (k + 1) % N, qDiag);
  }

  // L_tt (N×N) and L_tb (N×N)
  const L_tt: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => L[N + i][N + j])
  );
  const L_tb: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => L[N + i][j])
  );

  // Bottom positions (fixed)
  const bNodes = bottomIds.map(id => d.nodes.find(n => n.id === id)!);
  const bx = bNodes.map(n => n.x), by = bNodes.map(n => n.y);

  // RHS: -L_tb × x_b
  const rhsX = new Array(N).fill(0), rhsY = new Array(N).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    rhsX[i] -= L_tb[i][j] * bx[j];
    rhsY[i] -= L_tb[i][j] * by[j];
  }

  // Centroid constraint: replace last row with [1,...,1], rhs=0
  const L_reg = L_tt.map(row => [...row]);
  for (let j = 0; j < N; j++) L_reg[N - 1][j] = 1;
  rhsX[N - 1] = 0;
  rhsY[N - 1] = 0;

  const tx = solveLinalg(L_reg, rhsX);
  const ty = solveLinalg(L_reg, rhsY);
  if (!tx || !ty) return false;

  const tNodes = topIds.map(id => d.nodes.find(n => n.id === id)!);
  for (let i = 0; i < N; i++) {
    if (!isFinite(tx[i]) || !isFinite(ty[i])) return false;
    tNodes[i].x = tx[i];
    tNodes[i].y = ty[i];
  }

  return true;
}

// ═════════════════════════════════════════════════════════════════
// SEED: create first prism cell, return top face IDs
// ═════════════════════════════════════════════════════════════════

function applySeed(d: DiagramData, N: number): string[] | null {
  if (d.edges.some(e => e.elementType === 'compression')) return null;
  N = Math.max(3, Math.min(N, 6));
  const radius = 1.0 + rand(0, 0.5);

  const height = 1.5 + rand(0, 1.0); // uniform height for all top nodes

  const bottoms: DiagramNode[] = [];
  const tops: DiagramNode[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * i) / N;
    bottoms.push(makeNode(radius * Math.cos(theta), radius * Math.sin(theta), 0));
    tops.push(makeNode(radius * Math.cos(theta + 0.3), radius * Math.sin(theta + 0.3), height));
  }
  for (const n of [...bottoms, ...tops]) d.nodes.push(n);

  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(bottoms[i].id, tops[i].id, 'compression'));
    d.edges.push(makeEdge(bottoms[i].id, bottoms[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(tops[i].id, tops[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(bottoms[i].id, tops[(i + 1) % N].id, 'tension'));
  }

  // Form-find with correct force density ratios
  if (!formFindPrismLayer(d, bottoms.map(n => n.id), tops.map(n => n.id), N)) return null;
  return tops.map(n => n.id);
}

// ═════════════════════════════════════════════════════════════════
// ADHESION: stack a new prism cell on a given face
// ═════════════════════════════════════════════════════════════════

/**
 * Attach a new 3-strut prism cell using `faceIds` as the shared
 * bottom face. Returns the new top face IDs, or null on failure.
 */
function applyAdhesion(d: DiagramData, faceIds: string[]): string[] | null {
  const N = faceIds.length;
  if (N < 3) return null;

  const baseNodes = faceIds.map(id => d.nodes.find(n => n.id === id)!);
  if (baseNodes.some(n => !n)) return null;

  const cz = baseNodes.reduce((s, n) => s + n.z, 0) / N;
  const newHeight = cz + 1.0 + rand(0, 0.8);

  // Ensure the face has ring cables (they should exist from previous cell's top ring)
  for (let i = 0; i < N; i++) {
    if (!hasEdge(d.edges, faceIds[i], faceIds[(i + 1) % N])) {
      d.edges.push(makeEdge(faceIds[i], faceIds[(i + 1) % N], 'tension'));
    }
  }

  // Create new top nodes
  const topNodes: DiagramNode[] = [];
  for (let i = 0; i < N; i++) {
    topNodes.push(makeNode(baseNodes[i].x + rand(-0.3, 0.3), baseNodes[i].y + rand(-0.3, 0.3), newHeight));
    d.nodes.push(topNodes[i]);
  }

  // Struts: face[i] → top[i]
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(faceIds[i], topNodes[i].id, 'compression'));
  }

  // Top ring cables: top[i] → top[i+1]
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(topNodes[i].id, topNodes[(i + 1) % N].id, 'tension'));
  }

  // Diagonal cables: face[i] → top[i+1]
  for (let i = 0; i < N; i++) {
    if (!hasEdge(d.edges, faceIds[i], topNodes[(i + 1) % N].id)) {
      d.edges.push(makeEdge(faceIds[i], topNodes[(i + 1) % N].id, 'tension'));
    }
  }

  // Form-find with correct force density ratios
  if (!formFindPrismLayer(d, faceIds, topNodes.map(n => n.id), N)) return null;
  return topNodes.map(n => n.id);
}

// ═════════════════════════════════════════════════════════════════
// FUSION: remove a shared cable from between two layers
// ═════════════════════════════════════════════════════════════════

function applyFusion(d: DiagramData): boolean {
  const cables = d.edges.filter(e => e.elementType === 'tension');
  if (cables.length <= 9) return false;

  const shuffled = [...cables].sort(() => Math.random() - 0.5);
  for (const cable of shuffled) {
    const remaining = d.edges.filter(e => e.id !== cable.id);

    // Check connectivity
    const pEnds = new Set<string>();
    for (const e of remaining) if (e.elementType === 'compression') { pEnds.add(e.source); pEnds.add(e.target); }
    const adj = new Map<string, string[]>();
    for (const e of remaining) {
      if (e.elementType !== 'tension') continue;
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }
    if (pEnds.size > 0) {
      const visited = new Set<string>();
      const q = [[...pEnds][0]]; visited.add(q[0]);
      while (q.length > 0) { const c = q.shift()!; for (const nb of (adj.get(c) || [])) if (!visited.has(nb)) { visited.add(nb); q.push(nb); } }
      let connected = true;
      for (const pe of pEnds) if (!visited.has(pe)) { connected = false; break; }
      if (!connected) continue;
    }

    // Check each endpoint keeps ≥2 cables
    const srcC = remaining.filter(e => e.elementType === 'tension' && (e.source === cable.source || e.target === cable.source)).length;
    const tgtC = remaining.filter(e => e.elementType === 'tension' && (e.source === cable.target || e.target === cable.target)).length;
    if (srcC < 2 || tgtC < 2) continue;

    d.edges = remaining;
    if (formFindXY(d)) return true;
    d.edges = [...remaining, cable]; // restore
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════
// AUTO-EXPLORE
// ═════════════════════════════════════════════════════════════════

export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number,
  plateThickness: number = 3
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  _plateThickness = plateThickness;
  const d = cloneDiagram(diagram);
  const numSteps = Math.max(1, Math.min(steps, 30));
  const hasCompression = d.edges.some(e => e.elementType === 'compression');

  // Track the current top face for stacking
  let topFace: string[] | null = null;

  // SEED
  if (!hasCompression) {
    topFace = applySeed(d, 3);
    if (!topFace) return { diagram: d, forceGrammar };
  } else {
    // Find the top face from existing structure (highest z nodes with cables)
    const pEnds = plateEndpoints(d);
    const sorted = pEnds.map(id => d.nodes.find(n => n.id === id)!).filter(Boolean).sort((a, b) => b.z - a.z);
    if (sorted.length >= 3) topFace = sorted.slice(0, 3).map(n => n.id);
  }

  // GROW: stack prism cells
  const growSteps = hasCompression ? numSteps : Math.max(0, numSteps - 1);
  for (let step = 0; step < growSteps; step++) {
    if (!topFace || topFace.length < 3) break;

    const snapshot = cloneDiagram(d);
    const prevFace = [...topFace];

    // 90% adhesion, 10% fusion
    if (Math.random() < 0.1 && d.edges.filter(e => e.elementType === 'tension').length > 15) {
      applyFusion(d);
      continue;
    }

    const newFace = applyAdhesion(d, topFace);
    if (newFace) {
      topFace = newFace; // advance to new top
    } else {
      // Rollback
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      topFace = prevFace;
    }
  }

  // Clean up isolated nodes
  const connected = new Set<string>();
  for (const e of d.edges) { connected.add(e.source); connected.add(e.target); }
  d.nodes = d.nodes.filter(n => connected.has(n.id));

  return {
    diagram: d,
    forceGrammar: { ...forceGrammar, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true },
  };
}

// ─── Kept for compatibility ──────────────────────────────────────

export function initForceGrammar(d: DiagramData): ForceGrammarState { return { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true }; }
export function computeFeasibilityDomain(f: InterimForce, d: DiagramData): FeasibilityDomain { return { type: 'area' }; }
export function computeBinomialDomain(f1: InterimForce, f2: InterimForce, d: DiagramData): FeasibilityDomain { return { type: 'area' }; }
export function resolveForceAddNode(d: DiagramData, fg: ForceGrammarState, fid: string, x: number, y: number) { return { diagram: d, forceGrammar: fg }; }
export function resolveForceConnect(d: DiagramData, fg: ForceGrammarState, fid: string, tid: string) { return { diagram: d, forceGrammar: fg }; }
export function projectOntoLineOfAction(f: InterimForce, nm: Map<string, DiagramNode>, p: { x: number; y: number }) { return p; }
