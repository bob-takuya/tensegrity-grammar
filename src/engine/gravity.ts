/**
 * Self-weight (gravity) computation for tensegrity structures.
 *
 * Computes the gravitational forces on each node from the mass of
 * connected plates (compression members). Each plate's weight is
 * distributed equally to its two endpoint nodes.
 *
 * Material: MDF board
 *  - Density: ~750 kg/m³
 *  - Gravity: 9.81 m/s²
 *  - Units: world units = 0.1m, force in N
 */

import { DiagramData, DiagramNode, DiagramEdge, Vec2 } from '../types';

const MDF_DENSITY = 750;   // kg/m³
const GRAVITY = 9.81;      // m/s²
const WORLD_TO_M = 0.1;    // 1 world unit = 0.1m

/**
 * Compute self-weight forces for all nodes.
 * Returns a map from node id to the gravitational force vector (downward = negative y).
 */
export function computeSelfWeight(diagram: DiagramData): Map<string, Vec2> {
  const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
  const weights = new Map<string, Vec2>();

  // Initialize all nodes with zero weight
  for (const node of diagram.nodes) {
    weights.set(node.id, { x: 0, y: 0 });
  }

  // Distribute plate weights to endpoint nodes
  for (const edge of diagram.edges) {
    if (edge.elementType !== 'compression') continue;

    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;

    // Compute plate dimensions in meters
    const dx = (tgt.x - src.x) * WORLD_TO_M;
    const dy = (tgt.y - src.y) * WORLD_TO_M;
    const dz = (tgt.z - src.z) * WORLD_TO_M;
    const plateLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const plateWidth = edge.plateWidth * WORLD_TO_M;
    const plateThickness = edge.plateThickness / 1000; // mm to m

    // Volume and mass
    const volume = plateLength * plateWidth * plateThickness;
    const mass = volume * MDF_DENSITY;
    const weightForce = mass * GRAVITY;

    // Distribute half to each endpoint (downward force = negative y)
    const halfWeight = weightForce / 2;
    const wSrc = weights.get(edge.source)!;
    const wTgt = weights.get(edge.target)!;
    wSrc.y -= halfWeight;
    wTgt.y -= halfWeight;
  }

  return weights;
}

/**
 * Apply self-weight as external forces on the diagram.
 * Returns a new diagram with updated externalForce on each node.
 */
export function applySelfWeight(diagram: DiagramData): DiagramData {
  const weights = computeSelfWeight(diagram);

  return {
    ...diagram,
    nodes: diagram.nodes.map((node) => {
      const w = weights.get(node.id);
      if (!w || (Math.abs(w.x) < 1e-6 && Math.abs(w.y) < 1e-6)) return node;
      return {
        ...node,
        externalForce: {
          x: node.externalForce.x + w.x,
          y: node.externalForce.y + w.y,
        },
      };
    }),
  };
}
