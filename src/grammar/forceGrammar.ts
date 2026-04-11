/**
 * Force-Based Grammar Engine
 *
 * Based on:
 *  - Lee, Mueller, Fivet (IJSS 2016): form+force dual grammar rules
 *  - Mirtsopoulos & Fivet (archiDOCT 2020): single parametric rule with
 *    entropy rate, force selection, and feasibility domains
 *
 * Core concept: "interim forces" are unresolved force vectors at nodes.
 * Each grammar step places a new node and adds bars that absorb interim
 * forces along their axes. The remaining perpendicular component becomes
 * a new interim force. Supports act as sinks that absorb compatible forces.
 *
 * This guarantees equilibrium BY CONSTRUCTION — no post-hoc checking needed.
 */

import { DiagramData, DiagramNode, DiagramEdge, Vec2 } from '../types';
import { sub, add, scale, normalize, length, dot, perp, angle } from '../engine/geometry';
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
  // For 'line': ray from node in force direction
  origin?: Vec2;
  direction?: Vec2;
  // For 'point': intersection of two lines of action
  point?: Vec2;
}

export interface ForceGrammarState {
  active: boolean;
  interimForces: InterimForce[];
  selectedForceId: string | null;
  feasibilityDomain: FeasibilityDomain | null;
  isComplete: boolean; // true when no unresolved interim forces remain
}

// ─── Initialization ──────────────────────────────────────────────

/**
 * Initialize force grammar from the current diagram.
 * Creates interim forces from external loads (the forces that need
 * to be routed through the structure to the supports).
 */
export function initForceGrammar(diagram: DiagramData): ForceGrammarState {
  const interimForces: InterimForce[] = [];

  for (const node of diagram.nodes) {
    const { externalForce } = node;
    if (Math.abs(externalForce.x) > 1e-10 || Math.abs(externalForce.y) > 1e-10) {
      interimForces.push({
        id: generateId('if'),
        nodeId: node.id,
        // Interim force = the load that needs to be carried (same direction as applied load)
        fx: externalForce.x,
        fy: externalForce.y,
      });
    }
  }

  return {
    active: true,
    interimForces,
    selectedForceId: null,
    feasibilityDomain: null,
    isComplete: interimForces.length === 0,
  };
}

// ─── Feasibility Domain Computation ──────────────────────────────

/**
 * Compute the feasibility domain for placing a new node to resolve
 * the selected interim force.
 *
 * For monomial selection (1 force):
 *  - Line of action from the node in the force direction
 *
 * The new node can be placed anywhere on this line to maintain
 * equilibrium by construction.
 */
export function computeFeasibilityDomain(
  force: InterimForce,
  diagram: DiagramData
): FeasibilityDomain {
  const node = diagram.nodes.find((n) => n.id === force.nodeId);
  if (!node) return { type: 'area' };

  const fMag = Math.sqrt(force.fx * force.fx + force.fy * force.fy);
  if (fMag < 1e-10) return { type: 'point', point: { x: node.x, y: node.y } };

  // Line of action: from the node in the force direction
  return {
    type: 'line',
    origin: { x: node.x, y: node.y },
    direction: { x: force.fx / fMag, y: force.fy / fMag },
  };
}

/**
 * Compute feasibility domain for binomial selection (2 forces).
 * The intersection of two lines of action gives a single point
 * (convergence) or a line (stagnation).
 */
export function computeBinomialDomain(
  f1: InterimForce,
  f2: InterimForce,
  diagram: DiagramData
): FeasibilityDomain {
  const n1 = diagram.nodes.find((n) => n.id === f1.nodeId);
  const n2 = diagram.nodes.find((n) => n.id === f2.nodeId);
  if (!n1 || !n2) return { type: 'area' };

  // Intersection of two lines of action
  const p = lineLineIntersection(
    { x: n1.x, y: n1.y }, { x: f1.fx, y: f1.fy },
    { x: n2.x, y: n2.y }, { x: f2.fx, y: f2.fy }
  );

  if (p) {
    return { type: 'point', point: p };
  }

  // Parallel lines → no convergence point
  return { type: 'area' };
}

// ─── Rule Application ────────────────────────────────────────────

/**
 * Resolve an interim force by adding a new node and bar.
 *
 * The bar from the force's node (A) to the new node (P) absorbs
 * the component of the interim force along the A→P direction.
 * The perpendicular component stays at A as a residual interim force.
 * A new interim force at P equals the absorbed component.
 *
 * Returns the updated diagram and interim forces.
 */
export function resolveForceAddNode(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  forceId: string,
  newX: number,
  newY: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  const force = forceGrammar.interimForces.find((f) => f.id === forceId);
  if (!force) return { diagram, forceGrammar };

  const sourceNode = diagram.nodes.find((n) => n.id === force.nodeId);
  if (!sourceNode) return { diagram, forceGrammar };

  // Clone diagram
  const newDiagram: DiagramData = {
    nodes: diagram.nodes.map((n) => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: diagram.edges.map((e) => ({ ...e })),
  };

  // Create new node P
  const newNodeId = generateId('n');
  newDiagram.nodes.push({
    id: newNodeId,
    x: newX,
    y: newY,
    z: 0,
    support: 'free',
    externalForce: { x: 0, y: 0 },
  });

  // Add bar A→P
  newDiagram.edges.push({
    id: generateId('e'),
    source: force.nodeId,
    target: newNodeId,
    elementType: 'compression',
    plateWidth: 0.3,
    plateThickness: 3,
    plateAngle: 0,
  });

  // Compute force decomposition
  const forceVec: Vec2 = { x: force.fx, y: force.fy };
  const barDir = normalize(sub({ x: newX, y: newY }, { x: sourceNode.x, y: sourceNode.y }));
  const barDirLen = length(sub({ x: newX, y: newY }, { x: sourceNode.x, y: sourceNode.y }));

  if (barDirLen < 1e-10) return { diagram, forceGrammar };

  // Project interim force onto bar direction
  const projection = dot(forceVec, barDir);
  const absorbed: Vec2 = scale(barDir, projection);
  const residual: Vec2 = sub(forceVec, absorbed);

  // Update interim forces
  let newInterimForces = forceGrammar.interimForces.filter((f) => f.id !== forceId);

  // Add residual at source node (if non-negligible)
  if (length(residual) > 0.01) {
    // Check if source node already has another interim force
    const existingAtSource = newInterimForces.find((f) => f.nodeId === force.nodeId);
    if (existingAtSource) {
      existingAtSource.fx += residual.x;
      existingAtSource.fy += residual.y;
    } else {
      newInterimForces.push({
        id: generateId('if'),
        nodeId: force.nodeId,
        fx: residual.x,
        fy: residual.y,
      });
    }
  }

  // Add transferred force at new node P
  if (Math.abs(projection) > 0.01) {
    newInterimForces.push({
      id: generateId('if'),
      nodeId: newNodeId,
      fx: absorbed.x,
      fy: absorbed.y,
    });
  }

  // Check if new node is at a support → absorb compatible forces
  newInterimForces = absorbAtSupports(newDiagram, newInterimForces);

  const isComplete = newInterimForces.every((f) =>
    Math.abs(f.fx) < 0.01 && Math.abs(f.fy) < 0.01
  );
  newInterimForces = newInterimForces.filter((f) =>
    Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01
  );

  return {
    diagram: newDiagram,
    forceGrammar: {
      ...forceGrammar,
      interimForces: newInterimForces,
      selectedForceId: null,
      feasibilityDomain: null,
      isComplete: newInterimForces.length === 0,
    },
  };
}

/**
 * Resolve an interim force by connecting to an EXISTING node.
 * The bar absorbs force along its direction; the transferred
 * component adds to the target node's interim force.
 */
export function resolveForceConnect(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  forceId: string,
  targetNodeId: string
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  const force = forceGrammar.interimForces.find((f) => f.id === forceId);
  if (!force) return { diagram, forceGrammar };
  if (force.nodeId === targetNodeId) return { diagram, forceGrammar };

  const sourceNode = diagram.nodes.find((n) => n.id === force.nodeId);
  const targetNode = diagram.nodes.find((n) => n.id === targetNodeId);
  if (!sourceNode || !targetNode) return { diagram, forceGrammar };

  // Check no duplicate edge
  const exists = diagram.edges.some(
    (e) =>
      (e.source === force.nodeId && e.target === targetNodeId) ||
      (e.source === targetNodeId && e.target === force.nodeId)
  );
  if (exists) return { diagram, forceGrammar };

  // Clone diagram
  const newDiagram: DiagramData = {
    nodes: diagram.nodes.map((n) => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: diagram.edges.map((e) => ({ ...e })),
  };

  newDiagram.edges.push({
    id: generateId('e'),
    source: force.nodeId,
    target: targetNodeId,
    elementType: 'compression',
    plateWidth: 0.3,
    plateThickness: 3,
    plateAngle: 0,
  });

  // Force decomposition (same as above)
  const forceVec: Vec2 = { x: force.fx, y: force.fy };
  const barDir = normalize(sub(
    { x: targetNode.x, y: targetNode.y },
    { x: sourceNode.x, y: sourceNode.y }
  ));

  const projection = dot(forceVec, barDir);
  const absorbed: Vec2 = scale(barDir, projection);
  const residual: Vec2 = sub(forceVec, absorbed);

  let newInterimForces = forceGrammar.interimForces.filter((f) => f.id !== forceId);

  // Residual at source
  if (length(residual) > 0.01) {
    const existing = newInterimForces.find((f) => f.nodeId === force.nodeId);
    if (existing) {
      existing.fx += residual.x;
      existing.fy += residual.y;
    } else {
      newInterimForces.push({
        id: generateId('if'),
        nodeId: force.nodeId,
        fx: residual.x,
        fy: residual.y,
      });
    }
  }

  // Transferred to target
  if (Math.abs(projection) > 0.01) {
    const existing = newInterimForces.find((f) => f.nodeId === targetNodeId);
    if (existing) {
      existing.fx += absorbed.x;
      existing.fy += absorbed.y;
    } else {
      newInterimForces.push({
        id: generateId('if'),
        nodeId: targetNodeId,
        fx: absorbed.x,
        fy: absorbed.y,
      });
    }
  }

  // Absorb at supports
  newInterimForces = absorbAtSupports(newDiagram, newInterimForces);

  newInterimForces = newInterimForces.filter((f) =>
    Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01
  );

  return {
    diagram: newDiagram,
    forceGrammar: {
      ...forceGrammar,
      interimForces: newInterimForces,
      selectedForceId: null,
      feasibilityDomain: null,
      isComplete: newInterimForces.length === 0,
    },
  };
}

// ─── Support Absorption ──────────────────────────────────────────

/**
 * At support nodes, absorb the compatible component of interim forces.
 * - Pin: absorbs both components (full reaction)
 * - Roller-x: absorbs only y-component (vertical reaction)
 * - Roller-y: absorbs only x-component (horizontal reaction)
 */
function absorbAtSupports(
  diagram: DiagramData,
  forces: InterimForce[]
): InterimForce[] {
  const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));

  return forces.map((f) => {
    const node = nodeMap.get(f.nodeId);
    if (!node) return f;

    switch (node.support) {
      case 'pin':
        // Pin absorbs everything
        return { ...f, fx: 0, fy: 0 };
      case 'roller-x':
        // Roller-x provides vertical reaction only
        return { ...f, fy: 0 };
      case 'roller-y':
        // Roller-y provides horizontal reaction only
        return { ...f, fx: 0 };
      default:
        return f;
    }
  });
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Project a point onto the line of action of an interim force.
 * Returns the closest point on the line to the given point.
 */
export function projectOntoLineOfAction(
  force: InterimForce,
  nodeMap: Map<string, DiagramNode>,
  point: Vec2
): Vec2 {
  const node = nodeMap.get(force.nodeId);
  if (!node) return point;

  const fMag = Math.sqrt(force.fx * force.fx + force.fy * force.fy);
  if (fMag < 1e-10) return { x: node.x, y: node.y };

  const dir: Vec2 = { x: force.fx / fMag, y: force.fy / fMag };
  const toPoint = sub(point, { x: node.x, y: node.y });
  const t = dot(toPoint, dir);

  return add({ x: node.x, y: node.y }, scale(dir, t));
}

function lineLineIntersection(
  p1: Vec2, d1: Vec2,
  p2: Vec2, d2: Vec2
): Vec2 | null {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-10) return null; // parallel

  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
  return {
    x: p1.x + t * d1.x,
    y: p1.y + t * d1.y,
  };
}

// ─── Auto-Explore ────────────────────────────────────────────────

/**
 * Stochastic auto-explore for force-based grammar.
 *
 * Strategy per step:
 *  1. Pick a random interim force
 *  2. Decide: place a new node on/near line of action, OR connect to
 *     an existing support/node
 *  3. Apply the resolution
 *
 * Placement heuristics:
 *  - With probability ~40%, try to connect directly to a support node
 *    (convergence — reduces interim force count)
 *  - With probability ~30%, place a new node on the line of action at
 *    a random distance (stagnation — transfers force along a path)
 *  - With probability ~30%, place a new node off the line of action
 *    (divergence — splits force into axial + perpendicular)
 */
export function autoExploreForceGrammar(
  diagram: DiagramData,
  forceGrammar: ForceGrammarState,
  steps: number
): { diagram: DiagramData; forceGrammar: ForceGrammarState } {
  let currentDiagram = diagram;
  let currentFG = forceGrammar;

  const maxSteps = Math.min(steps, 50);

  for (let step = 0; step < maxSteps; step++) {
    // Filter active interim forces
    const activeForces = currentFG.interimForces.filter(
      (f) => Math.abs(f.fx) > 0.01 || Math.abs(f.fy) > 0.01
    );
    if (activeForces.length === 0) break;

    // Pick a random interim force
    const force = activeForces[Math.floor(Math.random() * activeForces.length)];
    const sourceNode = currentDiagram.nodes.find((n) => n.id === force.nodeId);
    if (!sourceNode) continue;

    const roll = Math.random();

    // Strategy 1: Try to connect to a support node (convergence)
    if (roll < 0.4) {
      const supports = currentDiagram.nodes.filter(
        (n) => n.support !== 'free' && n.id !== force.nodeId
      );
      if (supports.length > 0) {
        // Pick the closest support
        const target = supports.reduce((best, s) => {
          const dBest = Math.hypot(best.x - sourceNode.x, best.y - sourceNode.y);
          const dS = Math.hypot(s.x - sourceNode.x, s.y - sourceNode.y);
          return dS < dBest ? s : best;
        });
        // Check no duplicate edge
        const exists = currentDiagram.edges.some(
          (e) =>
            (e.source === force.nodeId && e.target === target.id) ||
            (e.source === target.id && e.target === force.nodeId)
        );
        if (!exists) {
          const result = resolveForceConnect(currentDiagram, currentFG, force.id, target.id);
          currentDiagram = result.diagram;
          currentFG = result.forceGrammar;
          continue;
        }
      }
    }

    // Strategy 2: Place on line of action (stagnation)
    if (roll < 0.7) {
      const fMag = Math.sqrt(force.fx * force.fx + force.fy * force.fy);
      if (fMag < 0.01) continue;
      const dir = { x: force.fx / fMag, y: force.fy / fMag };
      // Random distance along line of action (1 to 3 world units)
      const dist = 1 + Math.random() * 2;
      const nx = sourceNode.x + dir.x * dist;
      const ny = sourceNode.y + dir.y * dist;
      const result = resolveForceAddNode(currentDiagram, currentFG, force.id, nx, ny);
      currentDiagram = result.diagram;
      currentFG = result.forceGrammar;
      continue;
    }

    // Strategy 3: Place off line of action (divergence)
    {
      const fMag = Math.sqrt(force.fx * force.fx + force.fy * force.fy);
      if (fMag < 0.01) continue;
      const dir = { x: force.fx / fMag, y: force.fy / fMag };
      const perpDir = { x: -dir.y, y: dir.x };
      const dist = 1 + Math.random() * 2;
      const offset = (Math.random() - 0.5) * 2;
      const nx = sourceNode.x + dir.x * dist + perpDir.x * offset;
      const ny = sourceNode.y + dir.y * dist + perpDir.y * offset;
      const result = resolveForceAddNode(currentDiagram, currentFG, force.id, nx, ny);
      currentDiagram = result.diagram;
      currentFG = result.forceGrammar;
    }
  }

  return { diagram: currentDiagram, forceGrammar: currentFG };
}

