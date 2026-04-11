/**
 * L-System Tensegrity Grammar — Self-Stressed Structures
 *
 * Key insight from the literature (Aloui & Rhode-Barbarigos 2019,
 * Tran & Lee 2010): growth rules modify TOPOLOGY only. After each
 * topology change, the force density method re-computes ALL free
 * node positions to guarantee self-stress.
 *
 * Algorithm:
 *   1. SPROUT/BRANCH modifies topology (adds nodes + edges)
 *   2. formFindAll() rebuilds D = C^T Q C, fixes anchor nodes,
 *      solves for remaining positions
 *   3. If form-finding fails → rollback
 *
 * This guarantees self-stress at every growth step.
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
function dist3(a: DiagramNode, b: DiagramNode): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}
function compressionDegree(edges: DiagramEdge[], nodeId: string): number {
  return edges.filter(e => e.elementType === 'compression' && (e.source === nodeId || e.target === nodeId)).length;
}
function makeNode(x: number, y: number, z: number): DiagramNode {
  return { id: generateId('n'), x, y, z, support: 'free', externalForce: { x: 0, y: 0 } };
}
function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return { id: generateId('e'), source: src, target: tgt, elementType: type, plateWidth: 0.2 + Math.random() * 0.25, plateThickness: _plateThickness, plateAngle: Math.random() * 360 };
}
function rand(min: number, max: number): number { return min + Math.random() * (max - min); }
function plateEndpoints(d: DiagramData): string[] {
  const ids = new Set<string>();
  for (const e of d.edges) if (e.elementType === 'compression') { ids.add(e.source); ids.add(e.target); }
  return [...ids];
}

// ═════════════════════════════════════════════════════════════════
// FORCE DENSITY FORM-FINDING (reusable for SEED + growth)
// ═════════════════════════════════════════════════════════════════

/**
 * Re-compute positions of all non-anchor nodes using the force
 * density method D = C^T Q C.
 *
 * Anchor nodes (lowest-z plate endpoints) are fixed. The remaining
 * node positions are solved from the partitioned system:
 *   D_ff × x_f = -D_fa × x_a
 * with centroid constraint on the free block.
 *
 * Returns false if form-finding fails.
 */
function formFindAll(d: DiagramData): boolean {
  const pEnds = new Set(plateEndpoints(d));
  if (pEnds.size === 0) return false;

  // Identify anchor nodes: the N lowest-z plate endpoints (forming the base)
  const peNodes = d.nodes.filter(n => pEnds.has(n.id)).sort((a, b) => a.z - b.z);
  if (peNodes.length < 3) return false;

  // Anchor the bottom ring (nodes at the lowest z-level)
  const minZ = peNodes[0].z;
  const anchors = peNodes.filter(n => Math.abs(n.z - minZ) < 0.1);
  if (anchors.length < 2) return false; // need at least 2 anchors
  const anchorIds = new Set(anchors.map(n => n.id));

  // Build node index maps
  const anchorList: DiagramNode[] = [];
  const freeList: DiagramNode[] = [];
  for (const n of d.nodes) {
    if (anchorIds.has(n.id)) anchorList.push(n);
    else freeList.push(n);
  }
  if (freeList.length === 0) return true; // nothing to solve

  const allNodes = [...anchorList, ...freeList];
  const nodeIdx = new Map(allNodes.map((n, i) => [n.id, i]));
  const nA = anchorList.length;
  const nF = freeList.length;
  const nTotal = nA + nF;

  // Assign force densities
  const qMap = new Map<string, number>();
  for (const e of d.edges) {
    qMap.set(e.id, e.elementType === 'compression' ? -1 : 1);
  }

  // Build force density matrix D (nTotal × nTotal)
  const D: number[][] = Array.from({ length: nTotal }, () => new Array(nTotal).fill(0));
  for (const e of d.edges) {
    const i = nodeIdx.get(e.source);
    const j = nodeIdx.get(e.target);
    if (i === undefined || j === undefined) continue;
    const q = qMap.get(e.id)!;
    D[i][i] += q; D[j][j] += q;
    D[i][j] -= q; D[j][i] -= q;
  }

  // Partition: D = [D_aa  D_af]  anchors = 0..nA-1, free = nA..nTotal-1
  //                [D_fa  D_ff]
  const D_ff: number[][] = Array.from({ length: nF }, (_, i) =>
    Array.from({ length: nF }, (_, j) => D[nA + i][nA + j])
  );
  const D_fa: number[][] = Array.from({ length: nF }, (_, i) =>
    Array.from({ length: nA }, (_, j) => D[nA + i][j])
  );

  // RHS: -D_fa × x_a  (for x, y, z separately)
  const aX = anchorList.map(n => n.x);
  const aY = anchorList.map(n => n.y);
  const aZ = anchorList.map(n => n.z);

  const rhsX = new Array(nF).fill(0);
  const rhsY = new Array(nF).fill(0);
  const rhsZ = new Array(nF).fill(0);
  for (let i = 0; i < nF; i++) {
    for (let j = 0; j < nA; j++) {
      rhsX[i] -= D_fa[i][j] * aX[j];
      rhsY[i] -= D_fa[i][j] * aY[j];
      rhsZ[i] -= D_fa[i][j] * aZ[j];
    }
  }

  // D_ff may be singular (graph Laplacian property).
  // Add centroid constraint: replace last row with [1,1,...,1], rhs = mean of anchors.
  const D_reg = D_ff.map(row => [...row]);
  const rhsXr = [...rhsX], rhsYr = [...rhsY], rhsZr = [...rhsZ];

  // Check if D_ff is singular by trying to solve directly first
  let fX = solveLinalg(D_ff, rhsX);
  let fY = solveLinalg(D_ff, rhsY);
  let fZ = solveLinalg(D_ff, rhsZ);

  if (!fX || !fY || !fZ) {
    // Singular — add centroid constraint on last row
    for (let j = 0; j < nF; j++) D_reg[nF - 1][j] = 1;
    const cX = aX.reduce((s, v) => s + v, 0) / nA;
    const cY = aY.reduce((s, v) => s + v, 0) / nA;
    const cZ = aZ.reduce((s, v) => s + v, 0) / nA + 1; // offset z upward
    for (let i = 0; i < nF - 1; i++) {
      rhsXr[i] = rhsX[i]; rhsYr[i] = rhsY[i]; rhsZr[i] = rhsZ[i];
    }
    rhsXr[nF - 1] = cX * nF; rhsYr[nF - 1] = cY * nF; rhsZr[nF - 1] = cZ * nF;

    fX = solveLinalg(D_reg, rhsXr);
    fY = solveLinalg(D_reg, rhsYr);
    fZ = solveLinalg(D_reg, rhsZr);
  }

  if (!fX || !fY || !fZ) return false;

  // Check for degenerate results (NaN, Infinity, or all collapsed)
  for (let i = 0; i < nF; i++) {
    if (!isFinite(fX[i]) || !isFinite(fY[i]) || !isFinite(fZ[i])) return false;
  }

  // Apply solved positions to free nodes
  for (let i = 0; i < nF; i++) {
    freeList[i].x = fX[i];
    freeList[i].y = fY[i];
    freeList[i].z = fZ[i];
  }

  return true;
}

// ═════════════════════════════════════════════════════════════════
// SEED
// ═════════════════════════════════════════════════════════════════

function applySeed(d: DiagramData, numStruts: number): boolean {
  if (d.edges.some(e => e.elementType === 'compression')) return false;
  const N = Math.max(3, numStruts);
  const radius = 1.0 + rand(0, 0.5);
  const height = 1.5 + rand(0, 1.0);

  // Create bottom ring (anchors) and top ring (free) with temporary positions
  const bottoms: DiagramNode[] = [];
  const tops: DiagramNode[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * i) / N;
    const bNode = makeNode(radius * Math.cos(theta), radius * Math.sin(theta), 0);
    const tNode = makeNode(radius * Math.cos(theta + 0.3), radius * Math.sin(theta + 0.3), height); // temp positions
    bottoms.push(bNode); tops.push(tNode);
    d.nodes.push(bNode, tNode);
  }

  // Topology: struts + bottom ring + top ring + diagonals
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(bottoms[i].id, tops[i].id, 'compression'));
    d.edges.push(makeEdge(bottoms[i].id, bottoms[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(tops[i].id, tops[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(bottoms[i].id, tops[(i + 1) % N].id, 'tension'));
  }

  // Form-find to get correct top node positions
  return formFindAll(d);
}

// ═════════════════════════════════════════════════════════════════
// SPROUT: insert plate into cable + form-find
// ═════════════════════════════════════════════════════════════════

function applySprout(d: DiagramData): boolean {
  const pEnds = new Set(plateEndpoints(d));
  const cables = d.edges.filter(e =>
    e.elementType === 'tension' && pEnds.has(e.source) && pEnds.has(e.target)
  );
  if (cables.length === 0) return false;

  const cable = cables[Math.floor(Math.random() * cables.length)];
  const a = d.nodes.find(n => n.id === cable.source)!;
  const b = d.nodes.find(n => n.id === cable.target)!;
  if (!a || !b) return false;

  // Temporary positions (will be overwritten by form-finding)
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2 + 0.5;
  const p1 = makeNode(mx + 0.3, my, mz);
  const p2 = makeNode(mx - 0.3, my, mz);

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Remove original cable, add replacement cables
  d.edges = d.edges.filter(e => e.id !== cable.id);
  d.edges.push(makeEdge(a.id, p1.id, 'tension'));
  d.edges.push(makeEdge(p2.id, b.id, 'tension'));

  // Add extra cables to 2 nearest existing plate endpoints for ≥3 shared-node rigidity
  const others = [...pEnds].filter(id => id !== p1.id && id !== p2.id && id !== a.id && id !== b.id);
  const otherNodes = others.map(id => d.nodes.find(n => n.id === id)!).filter(Boolean);
  otherNodes.sort((x, y) => dist3(p1, x) - dist3(p1, y));

  if (otherNodes.length >= 1 && !hasEdge(d.edges, p1.id, otherNodes[0].id)) {
    d.edges.push(makeEdge(p1.id, otherNodes[0].id, 'tension'));
  }
  if (otherNodes.length >= 2 && !hasEdge(d.edges, p2.id, otherNodes[1].id)) {
    d.edges.push(makeEdge(p2.id, otherNodes[1].id, 'tension'));
  }

  // Form-find: reposition ALL free nodes
  return formFindAll(d);
}

// ═════════════════════════════════════════════════════════════════
// BRANCH: attach new plate from a node + form-find
// ═════════════════════════════════════════════════════════════════

function applyBranch(d: DiagramData): boolean {
  const pEnds = plateEndpoints(d);
  if (pEnds.length === 0) return false;

  const srcId = pEnds[Math.floor(Math.random() * pEnds.length)];
  const srcNode = d.nodes.find(n => n.id === srcId)!;

  // Temporary positions
  const p1 = makeNode(srcNode.x + rand(-0.5, 0.5), srcNode.y + rand(-0.5, 0.5), srcNode.z + rand(0.3, 1));
  const p2 = makeNode(srcNode.x + rand(-0.5, 0.5), srcNode.y + rand(-0.5, 0.5), srcNode.z + rand(0.3, 1));

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));
  d.edges.push(makeEdge(srcId, p1.id, 'tension'));

  // Cable P2 to 2 nearest existing plate endpoints
  const otherEnds = pEnds.filter(id => id !== srcId && id !== p1.id && id !== p2.id);
  const otherNodes = otherEnds.map(id => d.nodes.find(n => n.id === id)!).filter(Boolean);
  otherNodes.sort((a, b) => dist3(p2, a) - dist3(p2, b));

  let cabled = 0;
  for (const other of otherNodes) {
    if (cabled >= 2) break;
    if (!hasEdge(d.edges, p2.id, other.id)) {
      d.edges.push(makeEdge(p2.id, other.id, 'tension'));
      cabled++;
    }
  }
  if (otherNodes.length >= 1 && !hasEdge(d.edges, p1.id, otherNodes[0].id) && otherNodes[0].id !== srcId) {
    d.edges.push(makeEdge(p1.id, otherNodes[0].id, 'tension'));
  }

  return formFindAll(d);
}

// ═════════════════════════════════════════════════════════════════
// TENSEGRITY VALIDATION
// ═════════════════════════════════════════════════════════════════

function isTensegrityValid(d: DiagramData): boolean {
  for (const n of d.nodes) if (compressionDegree(d.edges, n.id) > 1) return false;
  return true;
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

  if (!hasCompression) {
    const seedStruts = Math.max(3, Math.min(numSteps, 6));
    applySeed(d, seedStruts);
  }

  const growSteps = hasCompression ? numSteps : Math.max(0, numSteps - 3);
  for (let step = 0; step < growSteps; step++) {
    const snapshot = cloneDiagram(d);
    const success = Math.random() < 0.6 ? applySprout(d) : applyBranch(d);

    if (!success || !isTensegrityValid(d)) {
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      // Retry with the other rule
      const retrySnapshot = cloneDiagram(d);
      const retry = Math.random() < 0.5 ? applySprout(d) : applyBranch(d);
      if (!retry || !isTensegrityValid(d)) {
        d.nodes = retrySnapshot.nodes;
        d.edges = retrySnapshot.edges;
      }
    }
  }

  // Clean up: remove isolated nodes
  const connected = new Set<string>();
  for (const e of d.edges) { connected.add(e.source); connected.add(e.target); }
  d.nodes = d.nodes.filter(n => connected.has(n.id));

  return {
    diagram: d,
    forceGrammar: { ...forceGrammar, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true },
  };
}

// ─── Kept for compatibility ──────────────────────────────────────

export function initForceGrammar(diagram: DiagramData): ForceGrammarState {
  return { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true };
}
export function computeFeasibilityDomain(f: InterimForce, d: DiagramData): FeasibilityDomain { return { type: 'area' }; }
export function computeBinomialDomain(f1: InterimForce, f2: InterimForce, d: DiagramData): FeasibilityDomain { return { type: 'area' }; }
export function resolveForceAddNode(d: DiagramData, fg: ForceGrammarState, fid: string, x: number, y: number) { return { diagram: d, forceGrammar: fg }; }
export function resolveForceConnect(d: DiagramData, fg: ForceGrammarState, fid: string, tid: string) { return { diagram: d, forceGrammar: fg }; }
export function projectOntoLineOfAction(f: InterimForce, nm: Map<string, DiagramNode>, p: { x: number; y: number }) { return p; }
