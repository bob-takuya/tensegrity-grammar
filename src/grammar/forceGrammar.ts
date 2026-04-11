/**
 * Cellular Morphogenesis for Tensegrity Structures
 *
 * Based on: Aloui, Orden, Rhode-Barbarigos (2018-2019)
 *   "Cellular morphogenesis of three-dimensional tensegrity structures"
 *
 * A tensegrity grows by attaching pre-formed CELLS (minimal self-stressed
 * units). Two operations:
 *
 *   ADHESION: A new cell shares ≥3 nodes with the existing structure.
 *     In 3D, sharing ≥3 non-collinear nodes preserves rigidity.
 *     The combined structure inherits self-stress from both parts.
 *
 *   FUSION: Remove shared/redundant edges after adhesion.
 *     Each removed edge decreases self-stress states by 1.
 *     This creates more minimal, interesting topologies.
 *
 * After each operation, formFindAll() repositions free nodes via
 * the force density method D = C^T Q C.
 */

import { DiagramData, DiagramNode, DiagramEdge, ElementType } from '../types';
import { generateId } from '../utils/id';
import { solve as solveLinalg } from '../engine/linalg';

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
function compressionDegree(edges: DiagramEdge[], nodeId: string): number {
  return edges.filter(e => e.elementType === 'compression' && (e.source === nodeId || e.target === nodeId)).length;
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
 * @param solveZ  If true, solve z from force density (for SEED).
 *                If false, keep current z positions (for ADHESION/growth).
 */
function formFindAll(d: DiagramData, solveZ: boolean = false): boolean {
  const pEnds = new Set(plateEndpoints(d));
  if (pEnds.size === 0) return false;

  // Anchor = lowest-z plate endpoints
  const peNodes = d.nodes.filter(n => pEnds.has(n.id)).sort((a, b) => a.z - b.z);
  if (peNodes.length < 3) return false;
  const minZ = peNodes[0].z;
  const anchors = peNodes.filter(n => Math.abs(n.z - minZ) < 0.1);
  if (anchors.length < 2) return false;
  const anchorIds = new Set(anchors.map(n => n.id));

  const anchorList: DiagramNode[] = [];
  const freeList: DiagramNode[] = [];
  for (const n of d.nodes) {
    if (anchorIds.has(n.id)) anchorList.push(n);
    else freeList.push(n);
  }
  if (freeList.length === 0) return true;

  const allNodes = [...anchorList, ...freeList];
  const nodeIdx = new Map(allNodes.map((n, i) => [n.id, i]));
  const nA = anchorList.length, nF = freeList.length, nTotal = nA + nF;

  // Build D = C^T Q C
  const D: number[][] = Array.from({ length: nTotal }, () => new Array(nTotal).fill(0));
  for (const e of d.edges) {
    const i = nodeIdx.get(e.source), j = nodeIdx.get(e.target);
    if (i === undefined || j === undefined) continue;
    const q = e.elementType === 'compression' ? -1 : 1;
    D[i][i] += q; D[j][j] += q; D[i][j] -= q; D[j][i] -= q;
  }

  // Partition
  const D_ff: number[][] = Array.from({ length: nF }, (_, i) => Array.from({ length: nF }, (_, j) => D[nA + i][nA + j]));
  const D_fa: number[][] = Array.from({ length: nF }, (_, i) => Array.from({ length: nA }, (_, j) => D[nA + i][j]));

  const aX = anchorList.map(n => n.x), aY = anchorList.map(n => n.y), aZ = anchorList.map(n => n.z);
  const rhsX = new Array(nF).fill(0), rhsY = new Array(nF).fill(0), rhsZ = new Array(nF).fill(0);
  for (let i = 0; i < nF; i++) for (let j = 0; j < nA; j++) {
    rhsX[i] -= D_fa[i][j] * aX[j]; rhsY[i] -= D_fa[i][j] * aY[j]; rhsZ[i] -= D_fa[i][j] * aZ[j];
  }

  let fX = solveLinalg(D_ff, rhsX), fY = solveLinalg(D_ff, rhsY), fZ = solveLinalg(D_ff, rhsZ);

  if (!fX || !fY) {
    // D_ff singular — add Tikhonov regularization: (D_ff + εI) x = rhs
    const eps = 0.001;
    const D_reg = D_ff.map((row, i) => row.map((v, j) => v + (i === j ? eps : 0)));
    fX = solveLinalg(D_reg, rhsX); fY = solveLinalg(D_reg, rhsY);
  }

  if (!fX || !fY) return false;
  for (let i = 0; i < nF; i++) {
    if (!isFinite(fX[i]) || !isFinite(fY[i])) return false;
  }

  // Apply positions
  for (let i = 0; i < nF; i++) {
    freeList[i].x = fX[i];
    freeList[i].y = fY[i];
  }

  // For SEED: also solve z via form-finding (with centroid constraint for height)
  if (solveZ) {
    let fZ = solveLinalg(D_ff, rhsZ);
    if (!fZ) {
      const D_regZ = D_ff.map(row => [...row]);
      for (let j = 0; j < nF; j++) D_regZ[nF - 1][j] = 1;
      const rZ = [...rhsZ];
      const targetZ = Math.max(...aZ) + 1.5 + rand(0, 0.5);
      rZ[nF - 1] = targetZ * nF;
      fZ = solveLinalg(D_regZ, rZ);
    }
    if (fZ) {
      for (let i = 0; i < nF; i++) {
        if (isFinite(fZ[i])) freeList[i].z = fZ[i];
      }
    }
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════
// CELL: minimal tensegrity unit (N-strut prism)
// ═════════════════════════════════════════════════════════════════

interface CellTopology {
  /** IDs of the "base" ring (shared with existing structure) */
  baseIds: string[];
  /** IDs of the "top" ring (new nodes) */
  topIds: string[];
  /** New nodes to add */
  newNodes: DiagramNode[];
  /** New edges to add */
  newEdges: DiagramEdge[];
}

/**
 * Create a cell topology that attaches to `baseNodeIds` (≥3 existing nodes).
 * The cell is an N-strut prism where N = baseNodeIds.length.
 *
 * Topology:
 *   Struts: base[i] → top[i]
 *   Top ring: top[i] → top[i+1]
 *   Diagonals: base[i] → top[i+1]
 *   (Base ring cables are NOT added — they may already exist in the host)
 */
function createCell(d: DiagramData, baseNodeIds: string[]): CellTopology | null {
  const N = baseNodeIds.length;
  if (N < 3) return null;

  // Check: none of the base nodes should already have a compression member
  // (tensegrity invariant: max 1 compression per node)
  for (const bid of baseNodeIds) {
    if (compressionDegree(d.edges, bid) >= 1) return null;
  }

  // Create top nodes with temporary positions (formFindAll will fix them)
  const baseNodes = baseNodeIds.map(id => d.nodes.find(n => n.id === id)!);
  const cx = baseNodes.reduce((s, n) => s + n.x, 0) / N;
  const cy = baseNodes.reduce((s, n) => s + n.y, 0) / N;
  const cz = baseNodes.reduce((s, n) => s + n.z, 0) / N;

  const newNodes: DiagramNode[] = [];
  const topIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const n = makeNode(cx + rand(-0.5, 0.5), cy + rand(-0.5, 0.5), cz + rand(1, 2));
    newNodes.push(n);
    topIds.push(n.id);
  }

  const newEdges: DiagramEdge[] = [];

  // Struts: base[i] → top[i]
  for (let i = 0; i < N; i++) {
    newEdges.push(makeEdge(baseNodeIds[i], topIds[i], 'compression'));
  }

  // Top ring cables: top[i] → top[i+1]
  for (let i = 0; i < N; i++) {
    newEdges.push(makeEdge(topIds[i], topIds[(i + 1) % N], 'tension'));
  }

  // Diagonal cables: base[i] → top[i+1]
  for (let i = 0; i < N; i++) {
    if (!hasEdge(d.edges, baseNodeIds[i], topIds[(i + 1) % N])) {
      newEdges.push(makeEdge(baseNodeIds[i], topIds[(i + 1) % N], 'tension'));
    }
  }

  return { baseIds: baseNodeIds, topIds, newNodes, newEdges };
}

// ═════════════════════════════════════════════════════════════════
// ADHESION: stack a full prism cell on a triangular face
// ═════════════════════════════════════════════════════════════════

/**
 * Proper adhesion (Aloui 2019): attach a complete N-strut prism cell
 * by sharing an existing triangular face (3 nodes + 3 cables).
 *
 * The shared face becomes the bottom ring of the new cell.
 * The new cell adds:
 *   - 3 new top nodes
 *   - 3 new struts (shared[i] → newTop[i])
 *   - 3 top ring cables (newTop[i] → newTop[i+1])
 *   - 3 diagonal cables (shared[i] → newTop[i+1])
 *   - 0 bottom ring cables (they already exist as the shared face)
 *
 * Shared nodes get a second strut — this is expected for Class-k
 * tensegrity (stacked prisms). The Maxwell count:
 *   Δ(s-m) = 3*3 - 3 - 6 = 0  (sharing 3 nodes, 3 edges → neutral)
 *
 * After adhesion, formFindAll() repositions all free nodes.
 */
function applyAdhesion(d: DiagramData): boolean {
  // Find all triangular faces: triples of nodes connected by 3 cables
  const cableAdj = new Map<string, Set<string>>();
  for (const e of d.edges) {
    if (e.elementType !== 'tension') continue;
    if (!cableAdj.has(e.source)) cableAdj.set(e.source, new Set());
    if (!cableAdj.has(e.target)) cableAdj.set(e.target, new Set());
    cableAdj.get(e.source)!.add(e.target);
    cableAdj.get(e.target)!.add(e.source);
  }

  // Find triangles among plate endpoints
  const pEnds = plateEndpoints(d);
  const faces: string[][] = [];

  for (let i = 0; i < pEnds.length; i++) {
    for (let j = i + 1; j < pEnds.length; j++) {
      if (!cableAdj.get(pEnds[i])?.has(pEnds[j])) continue;
      for (let k = j + 1; k < pEnds.length; k++) {
        if (!cableAdj.get(pEnds[j])?.has(pEnds[k])) continue;
        if (!cableAdj.get(pEnds[k])?.has(pEnds[i])) continue;
        faces.push([pEnds[i], pEnds[j], pEnds[k]]);
      }
    }
  }

  if (faces.length === 0) {
    // Fallback: use the 3 highest plate endpoints that are cable-connected to each other
    // Even if not a perfect triangle, they form the attachment surface
    const sorted = [...pEnds]
      .map(id => d.nodes.find(n => n.id === id)!)
      .filter(Boolean)
      .sort((a, b) => b.z - a.z);

    if (sorted.length >= 3) {
      // Pick top 3 and ensure they have at least some cable connectivity
      const top3 = sorted.slice(0, 3).map(n => n.id);
      // Add missing cables between them to form the face
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          if (!hasEdge(d.edges, top3[i], top3[j])) {
            d.edges.push(makeEdge(top3[i], top3[j], 'tension'));
          }
        }
      }
      faces.push(top3);
    }
  }

  if (faces.length === 0) return false;

  // Prefer faces at higher z (growth goes upward)
  faces.sort((a, b) => {
    const za = a.reduce((s, id) => s + (d.nodes.find(n => n.id === id)?.z || 0), 0);
    const zb = b.reduce((s, id) => s + (d.nodes.find(n => n.id === id)?.z || 0), 0);
    return zb - za;
  });

  // Pick one of the top faces (with some randomness)
  const topK = Math.min(3, faces.length);
  const face = faces[Math.floor(Math.random() * topK)];
  const baseNodes = face.map(id => d.nodes.find(n => n.id === id)!);

  // Centroid and height of the face
  const cx = baseNodes.reduce((s, n) => s + n.x, 0) / 3;
  const cy = baseNodes.reduce((s, n) => s + n.y, 0) / 3;
  const cz = baseNodes.reduce((s, n) => s + n.z, 0) / 3;

  // Create 3 new top nodes (temporary positions — formFindAll will fix x,y)
  const newHeight = cz + 1.0 + rand(0, 1.0);
  const topNodes: DiagramNode[] = [];
  for (let i = 0; i < 3; i++) {
    const n = makeNode(cx + rand(-0.5, 0.5), cy + rand(-0.5, 0.5), newHeight + rand(-0.2, 0.2));
    topNodes.push(n);
    d.nodes.push(n);
  }

  // Struts: base[i] → top[i]
  for (let i = 0; i < 3; i++) {
    d.edges.push(makeEdge(face[i], topNodes[i].id, 'compression'));
  }

  // Top ring cables: top[i] → top[i+1]
  for (let i = 0; i < 3; i++) {
    d.edges.push(makeEdge(topNodes[i].id, topNodes[(i + 1) % 3].id, 'tension'));
  }

  // Diagonal cables: base[i] → top[i+1]
  for (let i = 0; i < 3; i++) {
    if (!hasEdge(d.edges, face[i], topNodes[(i + 1) % 3].id)) {
      d.edges.push(makeEdge(face[i], topNodes[(i + 1) % 3].id, 'tension'));
    }
  }

  // Note: bottom ring cables already exist (they ARE the shared face)
  // No need to add them → this is proper adhesion

  return formFindAll(d);
}

// ═════════════════════════════════════════════════════════════════
// FUSION: remove redundant shared edges after adhesion
// ═════════════════════════════════════════════════════════════════

/**
 * Remove a random cable that is "redundant" (the structure would still
 * be connected and have self-stress without it). Each fusion reduces
 * self-stress states by 1 but creates a more minimal structure.
 */
function applyFusion(d: DiagramData): boolean {
  const cables = d.edges.filter(e => e.elementType === 'tension');
  if (cables.length <= 6) return false; // don't fuse below minimum

  // Shuffle and try removing each cable
  const shuffled = [...cables].sort(() => Math.random() - 0.5);

  for (const cable of shuffled) {
    // Check: removing this cable keeps the structure connected
    const remaining = d.edges.filter(e => e.id !== cable.id);
    if (!isTensionConnected(d.nodes, remaining)) continue;

    // Check: both endpoints still have ≥2 cables after removal
    const srcCables = remaining.filter(e => e.elementType === 'tension' && (e.source === cable.source || e.target === cable.source)).length;
    const tgtCables = remaining.filter(e => e.elementType === 'tension' && (e.source === cable.target || e.target === cable.target)).length;
    if (srcCables < 2 || tgtCables < 2) continue;

    // Remove the cable
    d.edges = remaining;

    // Re-form-find
    if (formFindAll(d)) return true;

    // Failed — restore
    d.edges = [...remaining, cable];
  }

  return false;
}

function isTensionConnected(nodes: DiagramNode[], edges: DiagramEdge[]): boolean {
  const pEnds = new Set<string>();
  for (const e of edges) if (e.elementType === 'compression') { pEnds.add(e.source); pEnds.add(e.target); }
  if (pEnds.size === 0) return true;

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.elementType !== 'tension') continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  const visited = new Set<string>();
  const start = [...pEnds][0];
  const q = [start]; visited.add(start);
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
    }
  }
  for (const pe of pEnds) if (!visited.has(pe)) return false;
  return true;
}

// ═════════════════════════════════════════════════════════════════
// TENSEGRITY VALIDATION
// ═════════════════════════════════════════════════════════════════

/**
 * Tensegrity validity — for stacked prisms (Class-k), shared nodes
 * have k struts. The essential check is that the tension network
 * is connected and all plate endpoints have at least 2 cables.
 */
function isTensegrityValid(d: DiagramData): boolean {
  // Check tension network connectivity
  if (!isTensionConnected(d.nodes, d.edges)) return false;

  // Every plate endpoint should have at least 2 cable connections
  const pEnds = new Set(plateEndpoints(d));
  for (const pe of pEnds) {
    const cableDeg = d.edges.filter(e => e.elementType === 'tension' && (e.source === pe || e.target === pe)).length;
    if (cableDeg < 2) return false;
  }

  return true;
}

// ═════════════════════════════════════════════════════════════════
// SEED: initial cell
// ═════════════════════════════════════════════════════════════════

function applySeed(d: DiagramData, numStruts: number): boolean {
  if (d.edges.some(e => e.elementType === 'compression')) return false;
  const N = Math.max(3, Math.min(numStruts, 6));
  const radius = 1.0 + rand(0, 0.5);

  // Bottom ring (anchors at z=0)
  const bottoms: DiagramNode[] = [];
  const tops: DiagramNode[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * i) / N;
    bottoms.push(makeNode(radius * Math.cos(theta), radius * Math.sin(theta), 0));
    tops.push(makeNode(radius * Math.cos(theta + 0.3), radius * Math.sin(theta + 0.3), 1.5 + rand(0, 1)));
  }
  for (const n of [...bottoms, ...tops]) d.nodes.push(n);

  // Topology: struts + top ring + diag + bottom ring
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(bottoms[i].id, tops[i].id, 'compression'));
    d.edges.push(makeEdge(bottoms[i].id, bottoms[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(tops[i].id, tops[(i + 1) % N].id, 'tension'));
    d.edges.push(makeEdge(bottoms[i].id, tops[(i + 1) % N].id, 'tension'));
  }

  return formFindAll(d, true); // solveZ for SEED
}

// ═════════════════════════════════════════════════════════════════
// AUTO-EXPLORE (cellular morphogenesis)
// ═════════════════════════════════════════════════════════════════

export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number,
  plateThickness: number = 3
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  _plateThickness = plateThickness;
  const d = cloneDiagram(diagram);
  const numSteps = Math.max(1, Math.min(steps, 20));
  const hasCompression = d.edges.some(e => e.elementType === 'compression');

  // Step 1: SEED if no structure
  if (!hasCompression) {
    const seedN = Math.max(3, Math.min(numSteps, 6));
    if (!applySeed(d, seedN)) return { diagram: d, forceGrammar };
  }

  // Step 2+: ADHESION (add cells) + occasional FUSION (remove redundant cables)
  const growSteps = hasCompression ? numSteps : Math.max(0, numSteps - 1);
  for (let step = 0; step < growSteps; step++) {
    const snapshot = cloneDiagram(d);

    // 70% adhesion, 30% fusion
    // Fusion only rarely — adhesion is the main growth operation
    const doFusion = Math.random() < 0.1 && d.edges.filter(e => e.elementType === 'tension').length > 15;

    let success: boolean;
    if (doFusion) {
      success = applyFusion(d);
    } else {
      success = applyAdhesion(d);
    }

    if (!success || !isTensegrityValid(d)) {
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      // Retry with adhesion if fusion failed (or vice versa)
      const retry = doFusion ? applyAdhesion(d) : applyFusion(d);
      if (!retry || !isTensegrityValid(d)) {
        d.nodes = snapshot.nodes;
        d.edges = snapshot.edges;
      }
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
