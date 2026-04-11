/**
 * L-System Tensegrity Grammar
 *
 * Grows tensegrity structures organically using production rules.
 * Each rule adds ONE compression plate (面材) and the MINIMUM cables
 * needed to attach it, always preserving the tensegrity invariant:
 *
 *   INVARIANT: Every compression member is isolated — no two
 *   compression members share a node. Each node connects to at
 *   most ONE compression member.
 *
 * Production Rules:
 *
 *   SEED:  ground supports → first plate suspended by cables
 *
 *   SPROUT: existing cable → insert a new plate along it
 *           A --cable-- B  →  A --cable-- P1 ==plate== P2 --cable-- B
 *           (original cable removed, plate floats between A and B)
 *
 *   BRANCH: existing node → attach a new plate branching away
 *           N  →  N --cable-- P1 ==plate== P2 --cable-- (nearest other node)
 *
 * The plates are MDF surfaces (面材) with width, thickness, and 3D angle.
 * They are NOT line elements — they are planar compression elements
 * that float in the tension cable network.
 */

import { DiagramData, DiagramNode, DiagramEdge, ElementType } from '../types';
import { generateId } from '../utils/id';

// ─── Re-export types used by state ───────────────────────────────

export interface InterimForce {
  id: string;
  nodeId: string;
  fx: number;
  fy: number;
}

export type EntropyRate = -1 | 0 | 1;

export interface FeasibilityDomain {
  type: 'point' | 'line' | 'area';
  origin?: { x: number; y: number };
  direction?: { x: number; y: number };
  point?: { x: number; y: number };
}

export interface ForceGrammarState {
  active: boolean;
  interimForces: InterimForce[];
  selectedForceId: string | null;
  feasibilityDomain: FeasibilityDomain | null;
  isComplete: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────

function cloneDiagram(d: DiagramData): DiagramData {
  return {
    nodes: d.nodes.map(n => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: d.edges.map(e => ({ ...e })),
  };
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

/** Check if adding a compression edge between these two nodes would violate tensegrity */
function wouldViolateTensegrity(edges: DiagramEdge[], a: string, b: string): boolean {
  return compressionDegree(edges, a) >= 1 || compressionDegree(edges, b) >= 1;
}

function makeNode(x: number, y: number, z: number): DiagramNode {
  return { id: generateId('n'), x, y, z, support: 'free', externalForce: { x: 0, y: 0 } };
}

/** Module-level plate thickness used during a single auto-explore run */
let _plateThickness = 3;

function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return {
    id: generateId('e'), source: src, target: tgt, elementType: type,
    plateWidth: 0.25 + Math.random() * 0.3,
    plateThickness: _plateThickness,
    plateAngle: Math.random() * 360,
  };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ─── Connectivity ────────────────────────────────────────────────

/** Get all nodes reachable from `start` via tension (cable) edges */
function tensionReachable(d: DiagramData, start: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of d.edges) {
    if (e.elementType !== 'tension') continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }
  const visited = new Set<string>();
  const q = [start];
  visited.add(start);
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
    }
  }
  return visited;
}

/** Repair disconnected tension network by adding cables between components */
function repairConnectivity(d: DiagramData): void {
  const allCableNodes = new Set<string>();
  for (const e of d.edges) {
    if (e.elementType === 'tension') { allCableNodes.add(e.source); allCableNodes.add(e.target); }
  }
  // Also include plate endpoints (they must be reachable)
  for (const e of d.edges) {
    if (e.elementType === 'compression') { allCableNodes.add(e.source); allCableNodes.add(e.target); }
  }
  // Include supports
  for (const n of d.nodes) {
    if (n.support !== 'free') allCableNodes.add(n.id);
  }
  if (allCableNodes.size === 0) return;

  // Find components and bridge them
  const assigned = new Set<string>();
  const components: Set<string>[] = [];
  for (const nid of allCableNodes) {
    if (assigned.has(nid)) continue;
    const comp = tensionReachable(d, nid);
    // Only include nodes that are in our target set
    const filtered = new Set([...comp].filter(id => allCableNodes.has(id)));
    for (const id of filtered) assigned.add(id);
    if (filtered.size > 0) components.push(filtered);
  }
  // Add isolated nodes as singleton components
  for (const nid of allCableNodes) {
    if (!assigned.has(nid)) {
      components.push(new Set([nid]));
      assigned.add(nid);
    }
  }

  // Bridge components: connect nearest pair between each pair
  while (components.length > 1) {
    let bestDist = Infinity;
    let bestA = '', bestB = '';
    let bestCompJ = 1;
    const nodesArr = d.nodes;
    const nodeMap = new Map(nodesArr.map(n => [n.id, n]));

    for (let j = 1; j < components.length; j++) {
      for (const aidRaw of components[0]) {
        const aid = aidRaw;
        const an = nodeMap.get(aid);
        if (!an) continue;
        for (const bid of components[j]) {
          const bn = nodeMap.get(bid);
          if (!bn) continue;
          if (hasEdge(d.edges, aid, bid)) continue;
          const dd = dist3(an, bn);
          if (dd < bestDist) { bestDist = dd; bestA = aid; bestB = bid; bestCompJ = j; }
        }
      }
    }

    if (bestA && bestB) {
      d.edges.push(makeEdge(bestA, bestB, 'tension'));
      // Merge components
      for (const id of components[bestCompJ]) components[0].add(id);
      components.splice(bestCompJ, 1);
    } else {
      break; // can't bridge
    }
  }
}

// ─── L-System Rules ──────────────────────────────────────────────

/**
 * SEED: First plate suspended from supports.
 * Both endpoints cabled to ALL supports for a solid foundation.
 */
function applySeed(d: DiagramData): boolean {
  const supports = d.nodes.filter(n => n.support !== 'free');
  if (supports.length < 2) return false;
  if (d.edges.some(e => e.elementType === 'compression')) return false;

  const cx = supports.reduce((s, n) => s + n.x, 0) / supports.length;
  const cy = supports.reduce((s, n) => s + n.y, 0) / supports.length;

  const z = 1.5 + rand(0, 1);
  const plateLen = 1 + rand(0, 1.5);
  const angle = rand(0, Math.PI * 2);
  const tilt = rand(0.2, 0.8);

  const p1 = makeNode(
    cx + Math.cos(angle) * plateLen * 0.5,
    cy + Math.sin(angle) * plateLen * 0.5,
    z + tilt * 0.5
  );
  const p2 = makeNode(
    cx - Math.cos(angle) * plateLen * 0.5,
    cy - Math.sin(angle) * plateLen * 0.5,
    z - tilt * 0.5
  );

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Cable BOTH endpoints to ALL supports → fully connected foundation
  for (const pNode of [p1, p2]) {
    for (const sup of supports) {
      if (!hasEdge(d.edges, pNode.id, sup.id)) {
        d.edges.push(makeEdge(pNode.id, sup.id, 'tension'));
      }
    }
  }

  return true;
}

/**
 * SPROUT: Insert plate along an existing cable.
 * The original cable A-B is removed. New cables: A→P1, P2→B.
 * Additionally P1 and P2 each get one more cable to a nearby node
 * to maintain connectivity.
 */
function applySprout(d: DiagramData): boolean {
  const cables = d.edges.filter(e => e.elementType === 'tension');
  if (cables.length === 0) return false;

  const cable = cables[Math.floor(Math.random() * cables.length)];
  const a = d.nodes.find(n => n.id === cable.source)!;
  const b = d.nodes.find(n => n.id === cable.target)!;
  if (!a || !b) return false;

  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
  const elevation = rand(0.3, 1.5);
  const plateLen = rand(0.5, 1.5);
  const angle = rand(0, Math.PI * 2);
  const tilt = rand(-0.4, 0.4);
  const latAngle = rand(0, Math.PI * 2);
  const latDist = rand(0.1, 0.8);

  const cx = mx + Math.cos(latAngle) * latDist;
  const cy = my + Math.sin(latAngle) * latDist;
  const cz = mz + elevation;

  const p1 = makeNode(cx + Math.cos(angle) * plateLen * 0.5, cy + Math.sin(angle) * plateLen * 0.5, cz + tilt);
  const p2 = makeNode(cx - Math.cos(angle) * plateLen * 0.5, cy - Math.sin(angle) * plateLen * 0.5, cz - tilt);

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Remove original cable
  d.edges = d.edges.filter(e => e.id !== cable.id);

  // Primary cables: A→P1, P2→B (replace the removed cable)
  d.edges.push(makeEdge(a.id, p1.id, 'tension'));
  d.edges.push(makeEdge(p2.id, b.id, 'tension'));

  // Secondary cable: P1 or P2 to another existing node for redundancy
  const existing = d.nodes.filter(n => n.id !== p1.id && n.id !== p2.id);
  existing.sort((x, y) => dist3(p1, x) - dist3(p1, y));
  for (const cand of existing) {
    if (cand.id === a.id || cand.id === b.id) continue;
    if (!hasEdge(d.edges, p2.id, cand.id)) {
      d.edges.push(makeEdge(p2.id, cand.id, 'tension'));
      break;
    }
  }

  return true;
}

/**
 * BRANCH: Attach a new plate branching from an existing node.
 * P1 cables to srcNode. P2 cables to TWO different existing nodes.
 */
function applyBranch(d: DiagramData): boolean {
  const candidates = d.nodes.filter(n => {
    const deg = d.edges.filter(e => e.source === n.id || e.target === n.id).length;
    return deg >= 1 && deg < 6;
  });
  if (candidates.length === 0) return false;

  const srcNode = candidates[Math.floor(Math.random() * candidates.length)];

  const angle = rand(0, Math.PI * 2);
  const upward = rand(0.5, 1.5);
  const outward = rand(0.5, 1.5);
  const plateLen = rand(0.5, 1.5);
  const plateAngle = rand(0, Math.PI * 2);

  const p1 = makeNode(
    srcNode.x + Math.cos(angle) * outward * 0.3,
    srcNode.y + Math.sin(angle) * outward * 0.3,
    srcNode.z + upward * 0.3
  );
  const p2 = makeNode(
    srcNode.x + Math.cos(angle) * outward + Math.cos(plateAngle) * plateLen * 0.5,
    srcNode.y + Math.sin(angle) * outward + Math.sin(plateAngle) * plateLen * 0.5,
    srcNode.z + upward + rand(-0.3, 0.3)
  );

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Cable: srcNode → P1
  d.edges.push(makeEdge(srcNode.id, p1.id, 'tension'));

  // Cable: P2 → two nearest existing nodes (not srcNode, not P1)
  const others = d.nodes
    .filter(n => n.id !== srcNode.id && n.id !== p1.id && n.id !== p2.id)
    .sort((a, b) => dist3(p2, a) - dist3(p2, b));

  let cabled = 0;
  for (const other of others) {
    if (cabled >= 2) break;
    if (!hasEdge(d.edges, p2.id, other.id)) {
      d.edges.push(makeEdge(p2.id, other.id, 'tension'));
      cabled++;
    }
  }

  return true;
}

// ─── Tensegrity Validation ───────────────────────────────────────

function isTensegrityValid(d: DiagramData): boolean {
  for (const node of d.nodes) {
    if (compressionDegree(d.edges, node.id) > 1) return false;
  }
  return true;
}

// ─── Main Auto-Explore ───────────────────────────────────────────

/**
 * L-System tensegrity growth.
 *
 * Each step applies one production rule, growing the structure
 * organically while maintaining the tensegrity invariant.
 *
 * Steps parameter = number of plates to add.
 *  Step 1 always applies SEED (first plate).
 *  Subsequent steps randomly choose SPROUT or BRANCH.
 */
export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number,
  plateThickness: number = 3
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  _plateThickness = plateThickness;
  const d = cloneDiagram(diagram);
  const numSteps = Math.max(1, Math.min(steps, 20));

  for (let step = 0; step < numSteps; step++) {
    // Save state for rollback if tensegrity is violated
    const snapshot = cloneDiagram(d);

    const hasCompression = d.edges.some(e => e.elementType === 'compression');

    let success: boolean;
    if (!hasCompression) {
      // First step: seed
      success = applySeed(d);
    } else {
      // Subsequent steps: randomly choose SPROUT or BRANCH
      const roll = Math.random();
      if (roll < 0.6) {
        success = applySprout(d);
      } else {
        success = applyBranch(d);
      }
    }

    // Validate tensegrity after each step
    if (success && !isTensegrityValid(d)) {
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      // Retry with the other rule
      if (Math.random() < 0.5) applySprout(d); else applyBranch(d);
      if (!isTensegrityValid(d)) {
        d.nodes = snapshot.nodes;
        d.edges = snapshot.edges;
      }
    }

    // Repair connectivity after each step
    if (success) repairConnectivity(d);
  }

  // Final connectivity repair
  repairConnectivity(d);

  // Clear interim forces — L-system doesn't use them
  return {
    diagram: d,
    forceGrammar: {
      ...forceGrammar,
      interimForces: [],
      selectedForceId: null,
      feasibilityDomain: null,
      isComplete: true,
    },
  };
}

// ─── Init / Domain (kept for manual mode compatibility) ──────────

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

export function computeFeasibilityDomain(force: InterimForce, diagram: DiagramData): FeasibilityDomain {
  const node = diagram.nodes.find(n => n.id === force.nodeId);
  if (!node) return { type: 'area' };
  const fMag = Math.sqrt(force.fx * force.fx + force.fy * force.fy);
  if (fMag < 1e-10) return { type: 'point', point: { x: node.x, y: node.y } };
  return { type: 'line', origin: { x: node.x, y: node.y }, direction: { x: force.fx / fMag, y: force.fy / fMag } };
}

export function computeBinomialDomain(f1: InterimForce, f2: InterimForce, diagram: DiagramData): FeasibilityDomain {
  return { type: 'area' };
}

export function resolveForceAddNode(
  diagram: DiagramData, fg: ForceGrammarState, forceId: string, newX: number, newY: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  return { diagram, forceGrammar: fg };
}

export function resolveForceConnect(
  diagram: DiagramData, fg: ForceGrammarState, forceId: string, targetNodeId: string
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  return { diagram, forceGrammar: fg };
}

export function projectOntoLineOfAction(
  force: InterimForce, nodeMap: Map<string, DiagramNode>, point: { x: number; y: number }
): { x: number; y: number } {
  return point;
}
