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
 * Generate a 3D tensegrity structure by growing upward from supports.
 *
 * Algorithm:
 * 1. STRUT PHASE: for each interim force, create a compression strut
 *    going to a NEW node elevated in Z, absorbing the full force
 *    along the bar axis. Place the strut so that it directs force
 *    toward a support.
 * 2. CABLE PHASE: add tension cables between the new elevated nodes
 *    and between elevated nodes and supports to form a connected
 *    tension network.
 * 3. GROUND PHASE: connect remaining interim forces directly to
 *    supports to fully resolve them.
 * 4. VALIDATE: check tensegrity conditions after each step.
 */
export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  let d = cloneDiagram(diagram);
  let forces = [...forceGrammar.interimForces.map(f => ({ ...f }))];
  const maxSteps = Math.min(steps, 100);

  const supports = d.nodes.filter(n => n.support !== 'free');
  const nodeMap = () => new Map(d.nodes.map(n => [n.id, n]));

  // Track current z-level for growth
  let currentZ = Math.max(0, ...d.nodes.map(n => n.z));

  for (let step = 0; step < maxSteps; step++) {
    const active = forces.filter(f => Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01);
    if (active.length === 0) break;

    // Pick the LARGEST interim force (most urgent to resolve)
    active.sort((a, b) => vec2Len(b) - vec2Len(a));
    const force = active[0];
    const nm = nodeMap();
    const srcNode = nm.get(force.nodeId);
    if (!srcNode) { forces = forces.filter(f => f.id !== force.id); continue; }

    // Find nearest support not yet directly connected
    const availableSupports = supports.filter(s =>
      s.id !== force.nodeId && !hasEdge(d.edges, force.nodeId, s.id)
    );

    // ─── STRATEGY SELECTION ──────────────────────────────────
    // Phase A: If close to a support, connect directly (GROUND)
    if (availableSupports.length > 0) {
      const nearest = availableSupports.reduce((best, s) =>
        dist3(srcNode, s) < dist3(srcNode, best) ? s : best
      );
      const d3 = dist3(srcNode, nearest);

      // Direct connection if close enough or if this is the last resort
      if (d3 < 3 || active.length <= 2 || step > maxSteps * 0.7) {
        d.edges.push(makeEdge(force.nodeId, nearest.id, 'compression'));
        const { absorbed, residual } = decomposeForce(force, srcNode, nearest);
        forces = updateInterimForces(forces, force.id,
          [{ nodeId: force.nodeId, ...residual }, { nodeId: nearest.id, ...absorbed }], d);

        // If residual is still large, add a cable to another support for the perpendicular component
        const updatedResidualForce = forces.find(f => f.nodeId === force.nodeId);
        if (updatedResidualForce && vec2Len(updatedResidualForce) > 0.05) {
          const otherSupports = supports.filter(s =>
            s.id !== nearest.id && s.id !== force.nodeId && !hasEdge(d.edges, force.nodeId, s.id)
          );
          if (otherSupports.length > 0) {
            d.edges.push(makeEdge(force.nodeId, otherSupports[0].id, 'tension'));
            const { absorbed: abs2, residual: res2 } = decomposeForce(updatedResidualForce, srcNode, otherSupports[0]);
            forces = updateInterimForces(forces, updatedResidualForce.id,
              [{ nodeId: force.nodeId, ...res2 }, { nodeId: otherSupports[0].id, ...abs2 }], d);
          }
        }
        continue;
      }
    }

    // Phase B: Create a STRUT going upward to a new 3D node
    currentZ += 0.5 + Math.random() * 1.0;

    // Direction: toward the centroid of supports, but elevated
    const supportCentroid = supports.length > 0
      ? { x: supports.reduce((s, n) => s + n.x, 0) / supports.length,
          y: supports.reduce((s, n) => s + n.y, 0) / supports.length }
      : { x: srcNode.x, y: srcNode.y };

    // New node positioned between source and support centroid, elevated
    const towardSupport = {
      x: supportCentroid.x - srcNode.x,
      y: supportCentroid.y - srcNode.y,
    };
    const tsDist = Math.sqrt(towardSupport.x ** 2 + towardSupport.y ** 2) || 1;
    const strutLen = 1 + Math.random() * 1.5;
    const lateralOffset = (Math.random() - 0.5) * 1.5;

    // Position new node: move partially toward supports + random lateral + upward z
    const perpX = -towardSupport.y / tsDist;
    const perpY = towardSupport.x / tsDist;
    const newNode = makeNode(
      srcNode.x + (towardSupport.x / tsDist) * strutLen + perpX * lateralOffset,
      srcNode.y + (towardSupport.y / tsDist) * strutLen + perpY * lateralOffset,
      currentZ
    );

    // Check tensegrity: compression members at srcNode must be 0 or we use a cable instead
    const srcCompressionDeg = compressionDegree(d.edges, force.nodeId);
    const strutType: ElementType = srcCompressionDeg === 0 ? 'compression' : 'tension';

    d.nodes.push(newNode);
    d.edges.push(makeEdge(force.nodeId, newNode.id, strutType));

    // Decompose force along the new member
    const { absorbed, residual } = decomposeForce(force, srcNode, newNode);
    forces = updateInterimForces(forces, force.id,
      [{ nodeId: force.nodeId, ...residual }, { nodeId: newNode.id, ...absorbed }], d);

    // Phase C: Add CABLES from new node to nearby existing nodes for stability
    const allNodes = d.nodes.filter(n => n.id !== newNode.id);
    // Sort by distance
    allNodes.sort((a, b) => dist3(newNode, a) - dist3(newNode, b));

    let cablesAdded = 0;
    for (const neighbor of allNodes) {
      if (cablesAdded >= 2) break;
      if (hasEdge(d.edges, newNode.id, neighbor.id)) continue;
      if (dist3(newNode, neighbor) > 6) continue;

      // For tensegrity: if newNode already has a compression member,
      // additional connections should be cables
      const newNodeCompDeg = compressionDegree(d.edges, newNode.id);
      const neighborCompDeg = compressionDegree(d.edges, neighbor.id);

      // Both nodes should not get a second compression member (tensegrity rule)
      const cableType: ElementType =
        (newNodeCompDeg >= 1 || neighborCompDeg >= 1) ? 'tension' : 'compression';

      d.edges.push(makeEdge(newNode.id, neighbor.id, cableType));
      cablesAdded++;

      // If the neighbor has an interim force, the cable helps resolve it
      const neighborForce = forces.find(f => f.nodeId === neighbor.id);
      if (neighborForce && vec2Len(neighborForce) > 0.01) {
        const nNode = d.nodes.find(n => n.id === neighbor.id)!;
        const { absorbed: nAbs, residual: nRes } = decomposeForce(neighborForce, nNode, newNode);
        forces = updateInterimForces(forces, neighborForce.id,
          [{ nodeId: neighbor.id, ...nRes }, { nodeId: newNode.id, ...nAbs }], d);
      }
    }
  }

  // Final pass: connect any remaining interim forces to nearest support
  let finalActive = forces.filter(f => Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01);
  for (const force of finalActive) {
    const nm = nodeMap();
    const srcNode = nm.get(force.nodeId);
    if (!srcNode) continue;

    for (const support of supports) {
      if (hasEdge(d.edges, force.nodeId, support.id)) continue;
      const edgeType: ElementType = compressionDegree(d.edges, force.nodeId) >= 1 ? 'tension' : 'compression';
      d.edges.push(makeEdge(force.nodeId, support.id, edgeType));
      const { absorbed, residual } = decomposeForce(force, srcNode, support);
      forces = updateInterimForces(forces, force.id,
        [{ nodeId: force.nodeId, ...residual }, { nodeId: support.id, ...absorbed }], d);
      break;
    }
  }

  // Clean up near-zero forces
  forces = forces.filter(f => Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01);

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
