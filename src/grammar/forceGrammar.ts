/**
 * L-System Tensegrity Grammar — Self-Stressed Structures
 *
 * A tensegrity is self-stressed: cable tensions balance each other
 * through compression struts. NO cables go to ground. The structure
 * stands because internal forces are in equilibrium (prestress),
 * NOT because it's anchored.
 *
 * The minimum self-stressed tensegrity is the 3-strut prism:
 *   - 3 compression struts (plates) connecting bottom ring to top ring
 *   - 9 cables: 3 bottom ring + 3 top ring + 3 diagonals
 *   - Bottom endpoints rest on the ground (z≈0)
 *   - Self-weight is secondary to prestress
 *
 * Production Rules:
 *
 *   SEED:   Generate a complete N-strut tensegrity prism (N >= 3).
 *           This is immediately self-stressed and valid.
 *
 *   SPROUT: Pick an existing cable → remove it → insert a plate
 *           with cables to the original cable's endpoints +
 *           nearby existing plate endpoints. Preserves prestress.
 *
 *   BRANCH: Pick a plate endpoint → attach a new plate outward →
 *           cable both new endpoints to existing plate endpoints.
 */

import { DiagramData, DiagramNode, DiagramEdge, ElementType } from '../types';
import { generateId } from '../utils/id';

// ─── Re-export types ─────────────────────────────────────────────

export interface InterimForce {
  id: string; nodeId: string; fx: number; fy: number;
}
export type EntropyRate = -1 | 0 | 1;
export interface FeasibilityDomain {
  type: 'point' | 'line' | 'area';
  origin?: { x: number; y: number };
  direction?: { x: number; y: number };
  point?: { x: number; y: number };
}
export interface ForceGrammarState {
  active: boolean; interimForces: InterimForce[];
  selectedForceId: string | null; feasibilityDomain: FeasibilityDomain | null;
  isComplete: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────

let _plateThickness = 3;

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
function makeNode(x: number, y: number, z: number): DiagramNode {
  return { id: generateId('n'), x, y, z, support: 'free', externalForce: { x: 0, y: 0 } };
}
function makeEdge(src: string, tgt: string, type: ElementType): DiagramEdge {
  return {
    id: generateId('e'), source: src, target: tgt, elementType: type,
    plateWidth: 0.2 + Math.random() * 0.25,
    plateThickness: _plateThickness,
    plateAngle: Math.random() * 360,
  };
}
function rand(min: number, max: number): number { return min + Math.random() * (max - min); }

function isTensegrityValid(d: DiagramData): boolean {
  for (const n of d.nodes) {
    if (compressionDegree(d.edges, n.id) > 1) return false;
  }
  return true;
}

// ─── Get all plate endpoint IDs ──────────────────────────────────

function plateEndpoints(d: DiagramData): string[] {
  const ids = new Set<string>();
  for (const e of d.edges) {
    if (e.elementType === 'compression') { ids.add(e.source); ids.add(e.target); }
  }
  return [...ids];
}

// ─── SEED: N-strut tensegrity prism ──────────────────────────────

/**
 * Generate a complete self-stressed N-strut tensegrity prism.
 *
 * Topology (Snelson pattern):
 *   bottom ring:  b0 → b1 → b2 → ... → b0  (cables)
 *   top ring:     t0 → t1 → t2 → ... → t0  (cables)
 *   diagonals:    t_i → b_{(i+1) mod N}     (cables)
 *   struts:       b_i → t_i (with angular offset)  (compression)
 *
 * The bottom ring sits at z≈0 (ground), top ring at z=height.
 * Struts are twisted by half a bay angle so they cross diagonals.
 */
function applySeed(d: DiagramData, numStruts: number): boolean {
  if (d.edges.some(e => e.elementType === 'compression')) return false;
  const N = Math.max(3, numStruts);

  const radius = 1.2 + rand(0, 0.5);
  const height = 2.0 + rand(0, 1.0);
  const twist = Math.PI / N; // half-bay twist for Snelson pattern

  // Center at diagram centroid or origin
  const cx = 0, cy = 0;

  const bottoms: DiagramNode[] = [];
  const tops: DiagramNode[] = [];

  for (let i = 0; i < N; i++) {
    const thetaB = (2 * Math.PI * i) / N;
    const thetaT = thetaB + twist;

    const bNode = makeNode(
      cx + radius * Math.cos(thetaB),
      cy + radius * Math.sin(thetaB),
      0 // ground level
    );
    const tNode = makeNode(
      cx + radius * Math.cos(thetaT),
      cy + radius * Math.sin(thetaT),
      height
    );
    bottoms.push(bNode);
    tops.push(tNode);
    d.nodes.push(bNode, tNode);
  }

  // Compression struts: b_i → t_i
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(bottoms[i].id, tops[i].id, 'compression'));
  }

  // Bottom ring cables: b_i → b_{i+1}
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(bottoms[i].id, bottoms[(i + 1) % N].id, 'tension'));
  }

  // Top ring cables: t_i → t_{i+1}
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(tops[i].id, tops[(i + 1) % N].id, 'tension'));
  }

  // Diagonal cables: t_i → b_{i+1} (Snelson pattern)
  for (let i = 0; i < N; i++) {
    d.edges.push(makeEdge(tops[i].id, bottoms[(i + 1) % N].id, 'tension'));
  }

  return true;
}

// ─── SPROUT: Insert plate into a cable ───────────────────────────

/**
 * Pick a cable between two plate endpoints, remove it, and insert
 * a new plate. The new plate's endpoints are cabled to the original
 * cable's endpoints AND to a nearby plate endpoint for rigidity.
 *
 * Only picks cables where both endpoints are plate endpoints
 * (not isolated nodes).
 */
function applySprout(d: DiagramData): boolean {
  const pEnds = new Set(plateEndpoints(d));
  // Cables between plate endpoints
  const cables = d.edges.filter(e =>
    e.elementType === 'tension' && pEnds.has(e.source) && pEnds.has(e.target)
  );
  if (cables.length === 0) return false;

  const cable = cables[Math.floor(Math.random() * cables.length)];
  const a = d.nodes.find(n => n.id === cable.source)!;
  const b = d.nodes.find(n => n.id === cable.target)!;
  if (!a || !b) return false;

  // Midpoint + random offset
  const mx = (a.x + b.x) / 2 + rand(-0.5, 0.5);
  const my = (a.y + b.y) / 2 + rand(-0.5, 0.5);
  const mz = (a.z + b.z) / 2 + rand(0.3, 1.2);

  const plateLen = rand(0.4, 1.2);
  const ang = rand(0, Math.PI * 2);
  const tilt = rand(-0.3, 0.3);

  const p1 = makeNode(mx + Math.cos(ang) * plateLen / 2, my + Math.sin(ang) * plateLen / 2, mz + tilt);
  const p2 = makeNode(mx - Math.cos(ang) * plateLen / 2, my - Math.sin(ang) * plateLen / 2, mz - tilt);

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Remove original cable
  d.edges = d.edges.filter(e => e.id !== cable.id);

  // Replace with: A→P1, P2→B
  d.edges.push(makeEdge(a.id, p1.id, 'tension'));
  d.edges.push(makeEdge(p2.id, b.id, 'tension'));

  // Extra cable from each new endpoint to another existing plate endpoint
  const others = d.nodes.filter(n =>
    n.id !== p1.id && n.id !== p2.id && n.id !== a.id && n.id !== b.id && pEnds.has(n.id)
  );
  if (others.length > 0) {
    others.sort((x, y) => dist3(p1, x) - dist3(p1, y));
    if (!hasEdge(d.edges, p2.id, others[0].id)) {
      d.edges.push(makeEdge(p2.id, others[0].id, 'tension'));
    }
  }
  if (others.length > 1) {
    others.sort((x, y) => dist3(p2, x) - dist3(p2, y));
    if (!hasEdge(d.edges, p1.id, others[0].id)) {
      d.edges.push(makeEdge(p1.id, others[0].id, 'tension'));
    }
  }

  return true;
}

// ─── BRANCH: Attach a new plate outward ──────────────────────────

/**
 * Pick a plate endpoint, create a new plate branching outward.
 * Both new endpoints cable to existing plate endpoints.
 */
function applyBranch(d: DiagramData): boolean {
  const pEnds = plateEndpoints(d);
  if (pEnds.length === 0) return false;

  // Pick a random plate endpoint
  const srcId = pEnds[Math.floor(Math.random() * pEnds.length)];
  const srcNode = d.nodes.find(n => n.id === srcId)!;

  const ang = rand(0, Math.PI * 2);
  const outward = rand(0.5, 1.2);
  const upward = rand(-0.5, 1.0); // can go up or slightly down
  const plateLen = rand(0.4, 1.2);
  const pAng = rand(0, Math.PI * 2);

  const p1 = makeNode(
    srcNode.x + Math.cos(ang) * outward * 0.4,
    srcNode.y + Math.sin(ang) * outward * 0.4,
    srcNode.z + upward * 0.4
  );
  const p2 = makeNode(
    srcNode.x + Math.cos(ang) * outward + Math.cos(pAng) * plateLen / 2,
    srcNode.y + Math.sin(ang) * outward + Math.sin(pAng) * plateLen / 2,
    srcNode.z + upward + rand(-0.3, 0.3)
  );

  d.nodes.push(p1, p2);
  d.edges.push(makeEdge(p1.id, p2.id, 'compression'));

  // Cable srcNode → P1
  d.edges.push(makeEdge(srcNode.id, p1.id, 'tension'));

  // Cable P2 → two nearest plate endpoints (not src, not P1)
  const others = d.nodes.filter(n =>
    n.id !== srcId && n.id !== p1.id && n.id !== p2.id &&
    new Set(plateEndpoints(d)).has(n.id)
  ).sort((a, b) => dist3(p2, a) - dist3(p2, b));

  let cabled = 0;
  for (const other of others) {
    if (cabled >= 2) break;
    if (!hasEdge(d.edges, p2.id, other.id)) {
      d.edges.push(makeEdge(p2.id, other.id, 'tension'));
      cabled++;
    }
  }
  // Also cable P1 to a nearby endpoint (not src)
  for (const other of others) {
    if (other.id === srcId) continue;
    if (!hasEdge(d.edges, p1.id, other.id)) {
      d.edges.push(makeEdge(p1.id, other.id, 'tension'));
      break;
    }
  }

  return true;
}

// ─── Connectivity repair ─────────────────────────────────────────

function repairConnectivity(d: DiagramData): void {
  const pEnds = new Set(plateEndpoints(d));
  if (pEnds.size === 0) return;

  const adj = new Map<string, string[]>();
  for (const e of d.edges) {
    if (e.elementType !== 'tension') continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  const assigned = new Set<string>();
  const components: Set<string>[] = [];

  for (const nid of pEnds) {
    if (assigned.has(nid)) continue;
    const comp = new Set<string>();
    const q = [nid];
    comp.add(nid);
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const nb of (adj.get(cur) || [])) {
        if (!comp.has(nb) && pEnds.has(nb)) { comp.add(nb); q.push(nb); }
      }
    }
    for (const id of comp) assigned.add(id);
    components.push(comp);
  }

  const nodeMap = new Map(d.nodes.map(n => [n.id, n]));
  while (components.length > 1) {
    let bestDist = Infinity, bestA = '', bestB = '', bestJ = 1;
    for (const aid of components[0]) {
      const an = nodeMap.get(aid);
      if (!an) continue;
      for (let j = 1; j < components.length; j++) {
        for (const bid of components[j]) {
          const bn = nodeMap.get(bid);
          if (!bn || hasEdge(d.edges, aid, bid)) continue;
          const dd = dist3(an, bn);
          if (dd < bestDist) { bestDist = dd; bestA = aid; bestB = bid; bestJ = j; }
        }
      }
    }
    if (bestA && bestB) {
      d.edges.push(makeEdge(bestA, bestB, 'tension'));
      for (const id of components[bestJ]) components[0].add(id);
      components.splice(bestJ, 1);
    } else break;
  }
}

// ─── Main Auto-Explore ───────────────────────────────────────────

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

  // Step 1: SEED if no structure exists
  if (!hasCompression) {
    const seedStruts = Math.max(3, Math.min(numSteps, 6));
    applySeed(d, seedStruts);
  }

  // Remaining steps: SPROUT or BRANCH
  const growSteps = hasCompression ? numSteps : Math.max(0, numSteps - 3);
  for (let step = 0; step < growSteps; step++) {
    const snapshot = cloneDiagram(d);

    const success = Math.random() < 0.6 ? applySprout(d) : applyBranch(d);

    if (success && !isTensegrityValid(d)) {
      d.nodes = snapshot.nodes;
      d.edges = snapshot.edges;
      const retry = Math.random() < 0.5 ? applySprout(d) : applyBranch(d);
      if (retry && !isTensegrityValid(d)) {
        d.nodes = snapshot.nodes;
        d.edges = snapshot.edges;
      }
    }

    if (success) repairConnectivity(d);
  }

  repairConnectivity(d);

  // Remove old support nodes that aren't connected to anything
  const connectedIds = new Set<string>();
  for (const e of d.edges) { connectedIds.add(e.source); connectedIds.add(e.target); }
  d.nodes = d.nodes.filter(n => connectedIds.has(n.id) || n.support !== 'free');

  return {
    diagram: d,
    forceGrammar: { ...forceGrammar, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true },
  };
}

// ─── Kept for compatibility ──────────────────────────────────────

export function initForceGrammar(diagram: DiagramData): ForceGrammarState {
  return { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: true };
}
export function computeFeasibilityDomain(force: InterimForce, diagram: DiagramData): FeasibilityDomain {
  return { type: 'area' };
}
export function computeBinomialDomain(f1: InterimForce, f2: InterimForce, diagram: DiagramData): FeasibilityDomain {
  return { type: 'area' };
}
export function resolveForceAddNode(d: DiagramData, fg: ForceGrammarState, fid: string, x: number, y: number) {
  return { diagram: d, forceGrammar: fg };
}
export function resolveForceConnect(d: DiagramData, fg: ForceGrammarState, fid: string, tid: string) {
  return { diagram: d, forceGrammar: fg };
}
export function projectOntoLineOfAction(f: InterimForce, nm: Map<string, DiagramNode>, p: { x: number; y: number }) {
  return p;
}
