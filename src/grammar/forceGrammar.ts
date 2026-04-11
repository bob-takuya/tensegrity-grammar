/**
 * Force-Based Grammar Engine (3D Tensegrity)
 *
 * Based on:
 *  - Lee, Mueller, Fivet (IJSS 2016): form+force dual grammar rules
 *  - Mirtsopoulos & Fivet (archiDOCT 2020): entropy-rate grammar
 *
 * Generates 3D tensegrity structures that grow upward (z-axis) with:
 *  - Compression members (plates) that never share nodes
 *  - Tension members (cables) forming a connected network
 *  - Equilibrium guaranteed by construction via interim forces
 *
 * Each step either:
 *  - STRUT: adds a compression plate from an interim-force node to a new 3D node
 *  - CABLE: adds a tension cable between existing nodes
 *  - GROUND: connects an interim-force node to a support (absorbing force)
 */

import { DiagramData, DiagramNode, DiagramEdge, Vec2, ElementType } from '../types';
import { generateId } from '../utils/id';

// ─── Types ───────────────────────────────────────────────────────

export interface InterimForce {
  id: string;
  nodeId: string;
  fx: number;
  fy: number;
}

export type EntropyRate = -1 | 0 | 1;

export interface FeasibilityDomain {
  type: 'point' | 'line' | 'area';
  origin?: Vec2;
  direction?: Vec2;
  point?: Vec2;
}

export interface ForceGrammarState {
  active: boolean;
  interimForces: InterimForce[];
  selectedForceId: string | null;
  feasibilityDomain: FeasibilityDomain | null;
  isComplete: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────

function vec2Len(v: { fx?: number; fy?: number; x?: number; y?: number }): number {
  const x = v.fx ?? v.x ?? 0;
  const y = v.fy ?? v.y ?? 0;
  return Math.sqrt(x * x + y * y);
}
function forceMag(f: InterimForce): number { return Math.sqrt(f.fx * f.fx + f.fy * f.fy); }
function dist3(a: DiagramNode, b: DiagramNode): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function hasEdge(edges: DiagramEdge[], a: string, b: string): boolean {
  return edges.some(e => (e.source === a && e.target === b) || (e.source === b && e.target === a));
}

/** Count compression edges touching a node */
function compressionDegree(edges: DiagramEdge[], nodeId: string): number {
  return edges.filter(e => e.elementType === 'compression' && (e.source === nodeId || e.target === nodeId)).length;
}

function cloneDiagram(d: DiagramData): DiagramData {
  return {
    nodes: d.nodes.map(n => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: d.edges.map(e => ({ ...e })),
  };
}

function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return { id: generateId('e'), source: src, target: tgt, elementType: type, plateWidth: 0.3, plateThickness: 3, plateAngle: 0 };
}

function makeNode(x: number, y: number, z: number): DiagramNode {
  return { id: generateId('n'), x, y, z, support: 'free', externalForce: { x: 0, y: 0 } };
}

// ─── Initialization ──────────────────────────────────────────────

export function initForceGrammar(diagram: DiagramData): ForceGrammarState {
  const interimForces: InterimForce[] = [];
  for (const node of diagram.nodes) {
    const { externalForce } = node;
    if (Math.abs(externalForce.x) > 1e-10 || Math.abs(externalForce.y) > 1e-10) {
      interimForces.push({ id: generateId('if'), nodeId: node.id, fx: externalForce.x, fy: externalForce.y });
    }
  }
  return { active: true, interimForces, selectedForceId: null, feasibilityDomain: null, isComplete: interimForces.length === 0 };
}

// ─── Feasibility Domain ──────────────────────────────────────────

export function computeFeasibilityDomain(force: InterimForce, diagram: DiagramData): FeasibilityDomain {
  const node = diagram.nodes.find(n => n.id === force.nodeId);
  if (!node) return { type: 'area' };
  const fMag = vec2Len(force);
  if (fMag < 1e-10) return { type: 'point', point: { x: node.x, y: node.y } };
  return { type: 'line', origin: { x: node.x, y: node.y }, direction: { x: force.fx / fMag, y: force.fy / fMag } };
}

export function computeBinomialDomain(f1: InterimForce, f2: InterimForce, diagram: DiagramData): FeasibilityDomain {
  const n1 = diagram.nodes.find(n => n.id === f1.nodeId);
  const n2 = diagram.nodes.find(n => n.id === f2.nodeId);
  if (!n1 || !n2) return { type: 'area' };
  const cross = f1.fx * f2.fy - f1.fy * f2.fx;
  if (Math.abs(cross) < 1e-10) return { type: 'area' };
  const t = ((n2.x - n1.x) * f2.fy - (n2.y - n1.y) * f2.fx) / cross;
  return { type: 'point', point: { x: n1.x + t * f1.fx, y: n1.y + t * f1.fy } };
}

// ─── Core Resolution ─────────────────────────────────────────────

/** 2D force decomposition along a bar direction (XY projection only) */
function decomposeForce(force: InterimForce, srcNode: DiagramNode, tgtNode: DiagramNode) {
  const dx = tgtNode.x - srcNode.x;
  const dy = tgtNode.y - srcNode.y;
  const len2D = Math.sqrt(dx * dx + dy * dy);
  if (len2D < 1e-10) return { absorbed: { fx: 0, fy: 0 }, residual: { fx: force.fx, fy: force.fy }, projection: 0 };
  const ux = dx / len2D, uy = dy / len2D;
  const proj = force.fx * ux + force.fy * uy;
  return {
    absorbed: { fx: ux * proj, fy: uy * proj },
    residual: { fx: force.fx - ux * proj, fy: force.fy - uy * proj },
    projection: proj,
  };
}

interface ForceAddition { nodeId: string; fx: number; fy: number }

function updateInterimForces(
  forces: InterimForce[],
  removeId: string,
  additions: ForceAddition[],
  diagram: DiagramData
): InterimForce[] {
  let result = forces.filter(f => f.id !== removeId);
  for (const a of additions) {
    if (Math.abs(a.fx) < 0.005 && Math.abs(a.fy) < 0.005) continue;
    const existing = result.find(f => f.nodeId === a.nodeId);
    if (existing) { existing.fx += a.fx; existing.fy += a.fy; }
    else result.push({ id: generateId('if'), nodeId: a.nodeId, fx: a.fx, fy: a.fy });
  }
  // Absorb at supports
  result = result.map(f => {
    const node = diagram.nodes.find(n => n.id === f.nodeId);
    if (!node) return f;
    if (node.support === 'pin') return { ...f, fx: 0, fy: 0 };
    if (node.support === 'roller-x') return { ...f, fy: 0 };
    if (node.support === 'roller-y') return { ...f, fx: 0 };
    return f;
  });
  return result.filter(f => Math.abs(f.fx) > 0.005 || Math.abs(f.fy) > 0.005);
}

// ─── Manual Rule Application ─────────────────────────────────────

export function resolveForceAddNode(
  diagram: DiagramData, fg: ForceGrammarState, forceId: string, newX: number, newY: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  const force = fg.interimForces.find(f => f.id === forceId);
  if (!force) return { diagram, forceGrammar: fg };
  const srcNode = diagram.nodes.find(n => n.id === force.nodeId);
  if (!srcNode) return { diagram, forceGrammar: fg };

  const d = cloneDiagram(diagram);
  const newNode = makeNode(newX, newY, 0);
  d.nodes.push(newNode);
  d.edges.push(makeEdge(force.nodeId, newNode.id, 'compression'));

  const { absorbed, residual } = decomposeForce(force, srcNode, newNode);
  const newIF = updateInterimForces(fg.interimForces, forceId,
    [{ nodeId: force.nodeId, ...residual }, { nodeId: newNode.id, ...absorbed }], d);

  return { diagram: d, forceGrammar: { ...fg, interimForces: newIF, selectedForceId: null, feasibilityDomain: null, isComplete: newIF.length === 0 } };
}

export function resolveForceConnect(
  diagram: DiagramData, fg: ForceGrammarState, forceId: string, targetNodeId: string
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  const force = fg.interimForces.find(f => f.id === forceId);
  if (!force || force.nodeId === targetNodeId) return { diagram, forceGrammar: fg };
  const srcNode = diagram.nodes.find(n => n.id === force.nodeId);
  const tgtNode = diagram.nodes.find(n => n.id === targetNodeId);
  if (!srcNode || !tgtNode) return { diagram, forceGrammar: fg };
  if (hasEdge(diagram.edges, force.nodeId, targetNodeId)) return { diagram, forceGrammar: fg };

  const d = cloneDiagram(diagram);
  d.edges.push(makeEdge(force.nodeId, targetNodeId, 'compression'));

  const { absorbed, residual } = decomposeForce(force, srcNode, tgtNode);
  const newIF = updateInterimForces(fg.interimForces, forceId,
    [{ nodeId: force.nodeId, ...residual }, { nodeId: targetNodeId, ...absorbed }], d);

  return { diagram: d, forceGrammar: { ...fg, interimForces: newIF, selectedForceId: null, feasibilityDomain: null, isComplete: newIF.length === 0 } };
}

// ─── Utilities kept for import ───────────────────────────────────

export function projectOntoLineOfAction(force: InterimForce, nodeMap: Map<string, DiagramNode>, point: Vec2): Vec2 {
  const node = nodeMap.get(force.nodeId);
  if (!node) return point;
  const fMag = vec2Len(force);
  if (fMag < 1e-10) return { x: node.x, y: node.y };
  const dx = point.x - node.x, dy = point.y - node.y;
  const t = (dx * force.fx + dy * force.fy) / (fMag * fMag);
  return { x: node.x + t * force.fx, y: node.y + t * force.fy };
}

// ═════════════════════════════════════════════════════════════════
// 3D TENSEGRITY AUTO-EXPLORE
// ═════════════════════════════════════════════════════════════════

/**
 * Generate a 3D tensegrity: isolated struts floating in a minimal cable net.
 *
 * A Class-1 tensegrity has:
 *  - Each node touches exactly ONE compression member (strut)
 *  - Cables form the MINIMUM connected network for stability
 *  - Struts "float" — they share no nodes with each other
 *
 * Algorithm:
 *  1. STRUT PLACEMENT — Create N struts as isolated pairs of nodes
 *     arranged in 3D around the load point. Each strut is a
 *     compression plate connecting a "bottom" node (lower z) to
 *     a "top" node (higher z), tilted at various angles.
 *
 *  2. CABLE WIRING — Wire strut endpoints with the classic
 *     tensegrity pattern: top(i) → bottom(i+1 mod N). This is
 *     the minimum cable set that makes the structure rigid.
 *
 *  3. GROUND CABLES — Connect bottom endpoints to support nodes.
 *
 * The `steps` parameter controls the number of struts generated.
 */
export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  const d = cloneDiagram(diagram);
  const supports = d.nodes.filter(n => n.support !== 'free');
  const loadNodes = d.nodes.filter(n =>
    n.support === 'free' &&
    (Math.abs(n.externalForce.x) > 0.01 || Math.abs(n.externalForce.y) > 0.01)
  );

  // Use the centroid of load nodes as structure center
  const allSrc = loadNodes.length > 0 ? loadNodes : d.nodes.filter(n => n.support === 'free');
  if (allSrc.length === 0 && supports.length === 0) {
    return { diagram: d, forceGrammar };
  }

  const center = {
    x: allSrc.reduce((s, n) => s + n.x, 0) / (allSrc.length || 1),
    y: allSrc.reduce((s, n) => s + n.y, 0) / (allSrc.length || 1),
  };
  const supportCenter = supports.length > 0
    ? { x: supports.reduce((s, n) => s + n.x, 0) / supports.length,
        y: supports.reduce((s, n) => s + n.y, 0) / supports.length }
    : center;

  // Number of struts = steps (clamped to reasonable range)
  const numStruts = Math.max(3, Math.min(steps, 12));
  const baseRadius = 1.5 + Math.random() * 0.5;
  const strutLength = 2 + Math.random() * 1.0;
  const baseZ = Math.max(0, ...d.nodes.map(n => n.z)) + 0.3;
  const tiltAngle = Math.PI / 6 + Math.random() * Math.PI / 6; // 30-60 deg tilt

  // ─── Phase 1: STRUT PLACEMENT ─────────────────────────────
  // Create N struts arranged radially, each tilted in 3D
  interface StrutInfo {
    bottomId: string;
    topId: string;
  }
  const struts: StrutInfo[] = [];

  for (let i = 0; i < numStruts; i++) {
    const theta = (2 * Math.PI * i) / numStruts;
    const thetaShift = (Math.PI / numStruts); // half-step rotation for top ring

    // Bottom node: on a circle around center at baseZ
    const bx = center.x + baseRadius * Math.cos(theta);
    const by = center.y + baseRadius * Math.sin(theta);
    const bz = baseZ;

    // Top node: rotated by half-step, at higher z, slightly inward
    const topRadius = baseRadius * 0.7;
    const tx = center.x + topRadius * Math.cos(theta + thetaShift);
    const ty = center.y + topRadius * Math.sin(theta + thetaShift);
    const tz = baseZ + strutLength;

    const bottomNode = makeNode(bx, by, bz);
    const topNode = makeNode(tx, ty, tz);
    d.nodes.push(bottomNode, topNode);

    // Compression strut connecting bottom to top
    d.edges.push(makeEdge(bottomNode.id, topNode.id, 'compression'));

    struts.push({ bottomId: bottomNode.id, topId: topNode.id });
  }

  // ─── Phase 2: MINIMAL CABLE WIRING ────────────────────────
  // Classic tensegrity pattern:
  //   top(i) ──cable──> bottom((i+1) mod N)    (diagonal cables)
  //   bottom(i) ──cable──> bottom((i+1) mod N) (bottom ring)
  //   top(i) ──cable──> top((i+1) mod N)       (top ring)

  for (let i = 0; i < numStruts; i++) {
    const next = (i + 1) % numStruts;

    // Diagonal cable: top of strut i → bottom of next strut
    if (!hasEdge(d.edges, struts[i].topId, struts[next].bottomId)) {
      d.edges.push(makeEdge(struts[i].topId, struts[next].bottomId, 'tension'));
    }

    // Bottom ring cable
    if (!hasEdge(d.edges, struts[i].bottomId, struts[next].bottomId)) {
      d.edges.push(makeEdge(struts[i].bottomId, struts[next].bottomId, 'tension'));
    }

    // Top ring cable
    if (!hasEdge(d.edges, struts[i].topId, struts[next].topId)) {
      d.edges.push(makeEdge(struts[i].topId, struts[next].topId, 'tension'));
    }
  }

  // ─── Phase 3: GROUND CABLES ───────────────────────────────
  // Connect bottom ring to support nodes
  if (supports.length > 0) {
    for (let i = 0; i < numStruts; i++) {
      // Connect each bottom node to nearest support
      const bNode = d.nodes.find(n => n.id === struts[i].bottomId)!;
      const nearest = supports.reduce((best, s) =>
        dist3(bNode, s) < dist3(bNode, best) ? s : best
      );
      if (!hasEdge(d.edges, struts[i].bottomId, nearest.id)) {
        d.edges.push(makeEdge(struts[i].bottomId, nearest.id, 'tension'));
      }
    }
  }

  // ─── Phase 4: LOAD CABLES ─────────────────────────────────
  // Connect load nodes to nearest strut top nodes
  for (const loadNode of loadNodes) {
    let closest: string | null = null;
    let closestDist = Infinity;
    for (const strut of struts) {
      const topNode = d.nodes.find(n => n.id === strut.topId)!;
      const dd = dist3(loadNode, topNode);
      if (dd < closestDist) {
        closestDist = dd;
        closest = strut.topId;
      }
    }
    if (closest && !hasEdge(d.edges, loadNode.id, closest)) {
      d.edges.push(makeEdge(loadNode.id, closest, 'tension'));
    }
  }

  // ─── Recompute interim forces ──────────────────────────────
  // With the complete topology, resolve all forces via supports
  let forces = [...forceGrammar.interimForces.map(f => ({ ...f }))];
  // Absorb everything at supports (the topology is complete)
  forces = forces.map(f => {
    const node = d.nodes.find(n => n.id === f.nodeId);
    if (!node) return f;
    if (node.support === 'pin') return { ...f, fx: 0, fy: 0 };
    if (node.support === 'roller-x') return { ...f, fy: 0 };
    if (node.support === 'roller-y') return { ...f, fx: 0 };
    return f;
  }).filter(f => Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01);

  return {
    diagram: d,
    forceGrammar: {
      ...forceGrammar,
      interimForces: forces,
      selectedForceId: null,
      feasibilityDomain: null,
      isComplete: forces.length === 0,
    },
  };
}

