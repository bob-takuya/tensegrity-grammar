/**
 * Force diagram (reciprocal diagram) construction.
 *
 * Given the form diagram's half-edge structure and computed member forces,
 * positions the force diagram nodes (one per face of the form diagram)
 * such that each force diagram edge is parallel to its form diagram counterpart
 * with length equal to the force magnitude.
 */

import {
  DiagramNode,
  DiagramEdge,
  ForceDiagramData,
  ForceDiagramNode,
  ForceDiagramEdge,
  ForcePolygon,
  ForcePolygonSegment,
  Vec2,
  EquilibriumResult,
} from '../types';
import { HalfEdgeStructure } from './halfEdge';
import { sub, normalize, scale, add, angle, length } from './geometry';

export function constructForceDiagram(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  halfEdgeStruct: HalfEdgeStructure,
  forces: Map<string, number>
): ForceDiagramData {
  const { halfEdges, faces } = halfEdgeStruct;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  if (faces.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Position force diagram nodes via BFS from the outer face
  const positions = new Map<string, { x: number; y: number }>();
  const outerFace = faces.find((f) => f.isOuter) || faces[0];

  // Place outer face at origin
  positions.set(outerFace.id, { x: 0, y: 0 });

  // Build adjacency: face → [(adjacent face, edge direction, force)]
  const faceAdj = new Map<string, { faceId: string; dx: number; dy: number; force: number; edgeId: string }[]>();

  for (const he of halfEdges.values()) {
    const twin = halfEdges.get(he.twin);
    if (!twin) continue;

    const faceA = he.face;
    const faceB = twin.face;
    if (!faceA || !faceB || faceA === faceB) continue;

    const originNode = nodeMap.get(he.origin);
    const targetNode = nodeMap.get(he.target);
    if (!originNode || !targetNode) continue;

    const d = sub(
      { x: targetNode.x, y: targetNode.y },
      { x: originNode.x, y: originNode.y }
    );
    const dir = normalize(d);
    const f = forces.get(he.edgeId) || 0;

    if (!faceAdj.has(faceA)) faceAdj.set(faceA, []);
    faceAdj.get(faceA)!.push({
      faceId: faceB,
      dx: dir.x,
      dy: dir.y,
      force: f,
      edgeId: he.edgeId,
    });
  }

  // BFS to position all face nodes
  const queue = [outerFace.id];
  const visited = new Set<string>([outerFace.id]);

  while (queue.length > 0) {
    const currentFace = queue.shift()!;
    const currentPos = positions.get(currentFace)!;
    const adj = faceAdj.get(currentFace) || [];

    for (const { faceId, dx, dy, force } of adj) {
      if (visited.has(faceId)) continue;
      visited.add(faceId);

      // Position: move from current face's point by force × direction
      // The direction goes from left face to right face in the half-edge convention
      const newPos = add(currentPos, scale({ x: dx, y: dy }, force));
      positions.set(faceId, newPos);
      queue.push(faceId);
    }
  }

  // Build force diagram nodes
  const fdNodes: ForceDiagramNode[] = [];
  for (const face of faces) {
    const pos = positions.get(face.id);
    if (pos) {
      fdNodes.push({ id: face.id, x: pos.x, y: pos.y });
    }
  }

  // Build force diagram edges (one per form edge, connecting two face nodes)
  const fdEdges: ForceDiagramEdge[] = [];
  const addedEdges = new Set<string>();

  for (const he of halfEdges.values()) {
    if (addedEdges.has(he.edgeId)) continue;
    addedEdges.add(he.edgeId);

    const twin = halfEdges.get(he.twin);
    if (!twin) continue;

    const faceA = he.face;
    const faceB = twin.face;
    if (!faceA || !faceB) continue;

    const f = forces.get(he.edgeId) || 0;

    fdEdges.push({
      id: he.edgeId,
      source: faceA,
      target: faceB,
      force: f,
    });
  }

  return { nodes: fdNodes, edges: fdEdges };
}

/**
 * Compute force polygons for each node.
 * Each polygon shows all forces at a node (member + external + reaction) head-to-tail.
 * If the polygon closes, the node is in equilibrium.
 */
export function computeForcePolygons(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  equilibrium: EquilibriumResult
): ForcePolygon[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const polygons: ForcePolygon[] = [];

  for (const node of nodes) {
    const segments: ForcePolygonSegment[] = [];

    // Collect all member forces at this node, sorted by angle for consistent ordering
    const memberForces: { edgeId: string; dx: number; dy: number; ang: number }[] = [];

    for (const edge of edges) {
      let otherNode: DiagramNode | undefined;
      let sign = 1;
      if (edge.source === node.id) {
        otherNode = nodeMap.get(edge.target);
        sign = 1;
      } else if (edge.target === node.id) {
        otherNode = nodeMap.get(edge.source);
        sign = -1;
      } else {
        continue;
      }
      if (!otherNode) continue;

      const f = equilibrium.forces.get(edge.id) || 0;
      const d = sub(
        { x: otherNode.x, y: otherNode.y },
        { x: node.x, y: node.y }
      );
      const dir = normalize(d);
      // Tension (f > 0) pulls toward other node; compression (f < 0) pushes away
      const fx = f * dir.x;
      const fy = f * dir.y;
      const ang = angle(d);

      memberForces.push({ edgeId: edge.id, dx: fx, dy: fy, ang });
    }

    // Sort by angle (clockwise from positive x-axis)
    memberForces.sort((a, b) => a.ang - b.ang);

    for (const mf of memberForces) {
      segments.push({
        label: mf.edgeId,
        dx: mf.dx,
        dy: mf.dy,
        type: 'member',
        force: equilibrium.forces.get(mf.edgeId) || 0,
      });
    }

    // External force
    const ef = node.externalForce;
    if (Math.abs(ef.x) > 1e-10 || Math.abs(ef.y) > 1e-10) {
      segments.push({
        label: 'external',
        dx: ef.x,
        dy: ef.y,
        type: 'external',
        force: length(ef),
      });
    }

    // Reaction force
    const reaction = equilibrium.reactions.get(node.id);
    if (reaction && (Math.abs(reaction.x) > 1e-10 || Math.abs(reaction.y) > 1e-10)) {
      segments.push({
        label: 'reaction',
        dx: reaction.x,
        dy: reaction.y,
        type: 'reaction',
        force: length(reaction),
      });
    }

    // Compute vertices (head-to-tail)
    const vertices: Vec2[] = [{ x: 0, y: 0 }];
    for (const seg of segments) {
      const prev = vertices[vertices.length - 1];
      vertices.push({ x: prev.x + seg.dx, y: prev.y + seg.dy });
    }

    const lastVertex = vertices[vertices.length - 1];
    const residual: Vec2 = { x: lastVertex.x, y: lastVertex.y };
    const closes = length(residual) < 0.01;

    polygons.push({
      nodeId: node.id,
      segments,
      vertices,
      closes,
      residual,
    });
  }

  return polygons;
}
