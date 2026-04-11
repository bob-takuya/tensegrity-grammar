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

function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return {
    id: generateId('e'), source: src, target: tgt, elementType: type,
    plateWidth: 0.25 + Math.random() * 0.3,
    plateThickness: 2.5 + Math.random() * 1.5,
    plateAngle: Math.random() * 360,
  };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ─── L-System Rules ──────────────────────────────────────────────

/**
 * SEED: Create the first plate suspended from ground supports by cables.
 * Picks 2-3 support nodes and suspends a plate above them.
 */
function applySeed(d: DiagramData): boolean {
  const supports = d.nodes.filter(n => n.support !== 'free');
  if (supports.length < 2) return false;
  // Don't seed if there are already compression members
  if (d.edges.some(e => e.elementType === 'compression')) return false;

  // Centroid of supports
  const cx = supports.reduce((s, n) => s + n.x, 0) / supports.length;
  const cy = supports.reduce((s, n) => s + n.y, 0) / supports.length;

  // Create a plate above the centroid, tilted randomly
  const z = 1.5 + rand(0, 1);
  const plateLen = 1 + rand(0, 1.5);
  const angle = rand(0, Math.PI * 2);
  const tilt = rand(0.2, 0.8); // z-axis tilt

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

  // Cable each plate endpoint to 1-2 nearest supports
  for (const pNode of [p1, p2]) {
    const sorted = [...supports].sort((a, b) => dist3(pNode, a) - dist3(pNode, b));
    const numCables = Math.min(sorted.length, 1 + Math.floor(Math.random() * 2));
    for (let i = 0; i < numCables; i++) {
      if (!hasEdge(d.edges, pNode.id, sorted[i].id)) {
        d.edges.push(makeEdge(pNode.id, sorted[i].id, 'tension'));
      }
    }
  }

  return true;
}

/**
 * SPROUT: Pick a cable and insert a new plate along it.
 *   A --cable-- B  →  A --cable-- P1 ==plate== P2 --cable-- B
 *
 * The plate "sprouts" off the cable path, elevated in 3D.
 * The original cable is removed. Two new cables connect the plate
 * endpoints back to A and B. The plate is elevated relative to the
 * cable midpoint and rotated randomly.
 */
function applySprout(d: DiagramData): boolean {
  const cables = d.edges.filter(e => e.elementType === 'tension');
  if (cables.length === 0) return false;

  // Pick a random cable
  const cable = cables[Math.floor(Math.random() * cables.length)];
  const a = d.nodes.find(n => n.id === cable.source)!;
  const b = d.nodes.find(n => n.id === cable.target)!;
  if (!a || !b) return false;

  // Midpoint of cable
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = (a.z + b.z) / 2;

  // Plate elevated above the cable midpoint
  const elevation = rand(0.5, 2.0);
  const plateLen = rand(0.5, 1.5);
  const angle = rand(0, Math.PI * 2);
  const tilt = rand(-0.4, 0.4);

  // Random lateral offset so plates don't stack directly
  const lateralAngle = rand(0, Math.PI * 2);
  const lateralDist = rand(0.2, 1.0);

  const cx = mx + Math.cos(lateralAngle) * lateralDist;
  const cy = my + Math.sin(lateralAngle) * lateralDist;
  const cz = mz + elevation;

  const p1 = makeNode(
    cx + Math.cos(angle) * plateLen * 0.5,
    cy + Math.sin(angle) * plateLen * 0.5,
    cz + tilt
  );
  const p2 = makeNode(
    cx - Math.cos(angle) * plateLen * 0.5,
    cy - Math.sin(angle) * plateLen * 0.5,
    cz - tilt
  );

  // Check: P1 and P2 must not already have compression members (they're new, so OK)
  // Check: A and B must not get a compression member (they keep their cables)

  d.nodes.push(p1, p2);

  // Add the compression plate
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Remove original cable
  d.edges = d.edges.filter(e => e.id !== cable.id);

  // Add cables: A → P1, P2 → B
  d.edges.push(makeEdge(a.id, p1.id, 'tension'));
  d.edges.push(makeEdge(p2.id, b.id, 'tension'));

  return true;
}

/**
 * BRANCH: Pick a node and attach a new plate branching away.
 *   N  →  N --cable-- P1 ==plate== P2 --cable-- (other node)
 *
 * The plate branches outward and upward from node N, and its far
 * end (P2) is cabled back to a different existing node for stability.
 */
function applyBranch(d: DiagramData): boolean {
  // Pick a node that does NOT already have max cables
  const candidates = d.nodes.filter(n => {
    const totalDeg = d.edges.filter(e => e.source === n.id || e.target === n.id).length;
    return totalDeg < 5; // avoid over-connecting
  });
  if (candidates.length === 0) return false;

  const srcNode = candidates[Math.floor(Math.random() * candidates.length)];

  // Branch direction: random, trending upward
  const angle = rand(0, Math.PI * 2);
  const upward = rand(0.5, 2.0);
  const outward = rand(0.5, 1.5);
  const plateLen = rand(0.5, 1.5);
  const plateAngle = rand(0, Math.PI * 2);

  const branchDir = {
    x: Math.cos(angle) * outward,
    y: Math.sin(angle) * outward,
    z: upward,
  };

  const p1 = makeNode(
    srcNode.x + branchDir.x * 0.3,
    srcNode.y + branchDir.y * 0.3,
    srcNode.z + branchDir.z * 0.3
  );
  const p2 = makeNode(
    srcNode.x + branchDir.x + Math.cos(plateAngle) * plateLen * 0.5,
    srcNode.y + branchDir.y + Math.sin(plateAngle) * plateLen * 0.5,
    srcNode.z + branchDir.z + rand(-0.3, 0.3)
  );

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Cable from srcNode to P1
  d.edges.push(makeEdge(srcNode.id, p1.id, 'tension'));

  // Cable from P2 to a nearby existing node (not srcNode, not p1)
  const others = d.nodes.filter(n =>
    n.id !== srcNode.id && n.id !== p1.id && n.id !== p2.id &&
    !hasEdge(d.edges, p2.id, n.id)
  );
  if (others.length > 0) {
    // Pick one of the 3 nearest
    others.sort((a, b) => dist3(p2, a) - dist3(p2, b));
    const pick = others[Math.min(Math.floor(Math.random() * 3), others.length - 1)];
    d.edges.push(makeEdge(p2.id, pick.id, 'tension'));
  }

  return true;
}

// ─── Tensegrity Validation ───────────────────────────────────────

function isTensegrityValid(d: DiagramData): boolean {
  // Rule 1: No node touches more than 1 compression member
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
  steps: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
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
      // Rollback
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      // Try the other rule
      if (Math.random() < 0.5) {
        applySprout(d);
      } else {
        applyBranch(d);
      }
      // If still invalid, rollback again
      if (!isTensegrityValid(d)) {
        d.nodes = snapshot.nodes;
        d.edges = snapshot.edges;
      }
    }
  }

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
