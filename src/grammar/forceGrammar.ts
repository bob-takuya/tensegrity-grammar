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
    // Singular → centroid constraint for x, y
    const D_reg = D_ff.map(row => [...row]);
    for (let j = 0; j < nF; j++) D_reg[nF - 1][j] = 1;
    const cX = aX.reduce((s, v) => s + v, 0) / nA;
    const cY = aY.reduce((s, v) => s + v, 0) / nA;
    const rX = [...rhsX], rY = [...rhsY];
    rX[nF - 1] = cX * nF; rY[nF - 1] = cY * nF;
    fX = solveLinalg(D_reg, rX); fY = solveLinalg(D_reg, rY);
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
// ADHESION: attach a single-strut cell via cables only
// ═════════════════════════════════════════════════════════════════

/**
 * Growth cell: 1 new compression strut (2 new nodes), connected to
 * ≥3 existing nodes via cables only.
 *
 * This preserves the tensegrity invariant: existing nodes only gain
 * cable connections (tension), never a second compression member.
 *
 * The new strut endpoints are positioned by formFindAll().
 */
function applyAdhesion(d: DiagramData): boolean {
  const pEnds = plateEndpoints(d);
  if (pEnds.length < 3) return false;

  // Pick 3 existing plate endpoints as attachment points
  // Prefer nodes at higher z (growth goes upward) and spread apart
  const peNodes = pEnds.map(id => d.nodes.find(n => n.id === id)!).filter(Boolean);
  if (peNodes.length < 3) return false;

  // Shuffle and pick 3 that are reasonably spread
  const shuffled = [...peNodes].sort(() => Math.random() - 0.5);
  const attachIds = shuffled.slice(0, 3).map(n => n.id);
  const attachNodes = attachIds.map(id => d.nodes.find(n => n.id === id)!);

  // Centroid of attachment points
  const cx = attachNodes.reduce((s, n) => s + n.x, 0) / 3;
  const cy = attachNodes.reduce((s, n) => s + n.y, 0) / 3;
  const cz = attachNodes.reduce((s, n) => s + n.z, 0) / 3;

  // Create 2 new nodes (strut endpoints) with temporary positions
  // Place them above the attachment centroid
  const p1 = makeNode(cx + rand(-0.5, 0.5), cy + rand(-0.5, 0.5), cz + rand(0.8, 1.5));
  const p2 = makeNode(cx + rand(-0.5, 0.5), cy + rand(-0.5, 0.5), cz + rand(0.8, 1.5));

  d.nodes.push(p1, p2);

  // New strut
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Cables from P1 to 2 attachment nodes, P2 to the other 1 + 1 shared
  if (!hasEdge(d.edges, p1.id, attachIds[0])) d.edges.push(makeEdge(p1.id, attachIds[0], 'tension'));
  if (!hasEdge(d.edges, p1.id, attachIds[1])) d.edges.push(makeEdge(p1.id, attachIds[1], 'tension'));
  if (!hasEdge(d.edges, p2.id, attachIds[1])) d.edges.push(makeEdge(p2.id, attachIds[1], 'tension'));
  if (!hasEdge(d.edges, p2.id, attachIds[2])) d.edges.push(makeEdge(p2.id, attachIds[2], 'tension'));

  // Form-find
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

function isTensegrityValid(d: DiagramData): boolean {
  for (const n of d.nodes) if (compressionDegree(d.edges, n.id) > 1) return false;
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
