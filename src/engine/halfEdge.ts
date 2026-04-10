/**
 * Half-edge data structure for planar graphs.
 * Used to find faces for the reciprocal diagram construction.
 */

import { DiagramNode, DiagramEdge } from '../types';
import { angle, sub } from './geometry';

export interface HalfEdge {
  id: string;
  origin: string;      // node id
  target: string;      // node id
  twin: string;        // half-edge id of twin
  next: string;        // half-edge id of next in face cycle
  face: string;        // face id
  edgeId: string;      // original undirected edge id
}

export interface Face {
  id: string;
  halfEdge: string;    // one half-edge on this face's boundary
  isOuter: boolean;
}

export interface HalfEdgeStructure {
  halfEdges: Map<string, HalfEdge>;
  faces: Face[];
}

/** Build the half-edge structure from a planar graph. */
export function buildHalfEdgeStructure(
  nodes: DiagramNode[],
  edges: DiagramEdge[]
): HalfEdgeStructure {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const halfEdges = new Map<string, HalfEdge>();

  // Create half-edges for each undirected edge
  for (const edge of edges) {
    const heId1 = `he_${edge.id}_fwd`;
    const heId2 = `he_${edge.id}_rev`;

    halfEdges.set(heId1, {
      id: heId1,
      origin: edge.source,
      target: edge.target,
      twin: heId2,
      next: '',     // filled later
      face: '',     // filled later
      edgeId: edge.id,
    });

    halfEdges.set(heId2, {
      id: heId2,
      origin: edge.target,
      target: edge.source,
      twin: heId1,
      next: '',
      face: '',
      edgeId: edge.id,
    });
  }

  // Group half-edges by origin node
  const outgoing = new Map<string, HalfEdge[]>();
  for (const he of halfEdges.values()) {
    if (!outgoing.has(he.origin)) {
      outgoing.set(he.origin, []);
    }
    outgoing.get(he.origin)!.push(he);
  }

  // Sort outgoing half-edges by angle (counterclockwise)
  for (const [nodeId, hes] of outgoing) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    hes.sort((a, b) => {
      const tgtA = nodeMap.get(a.target)!;
      const tgtB = nodeMap.get(b.target)!;
      const angA = angle(sub({ x: tgtA.x, y: tgtA.y }, { x: node.x, y: node.y }));
      const angB = angle(sub({ x: tgtB.x, y: tgtB.y }, { x: node.x, y: node.y }));
      return angA - angB;
    });
    outgoing.set(nodeId, hes);
  }

  // Link half-edges: next(he(u→v)) is found by looking at node v's sorted outgoing edges
  // and finding the one BEFORE twin(he) in the counterclockwise order (i.e., the clockwise neighbor)
  for (const he of halfEdges.values()) {
    const targetOutgoing = outgoing.get(he.target);
    if (!targetOutgoing || targetOutgoing.length === 0) continue;

    // Find the twin in the target's outgoing list
    const twinId = he.twin;
    // The twin goes from target back to origin
    // Find it in the target's sorted outgoing list
    const twinIdx = targetOutgoing.findIndex((h) => h.id === twinId);
    if (twinIdx === -1) continue;

    // The previous entry (clockwise) in the CCW-sorted list
    const prevIdx = (twinIdx - 1 + targetOutgoing.length) % targetOutgoing.length;
    he.next = targetOutgoing[prevIdx].id;
  }

  // Find faces by following next pointers
  const visited = new Set<string>();
  const faces: Face[] = [];
  let faceCounter = 0;

  for (const he of halfEdges.values()) {
    if (visited.has(he.id)) continue;

    const faceId = `face_${faceCounter++}`;
    const cycle: string[] = [];
    let current = he;

    while (!visited.has(current.id)) {
      visited.add(current.id);
      current.face = faceId;
      cycle.push(current.id);
      const nextHe = halfEdges.get(current.next);
      if (!nextHe) break;
      current = nextHe;
    }

    faces.push({
      id: faceId,
      halfEdge: he.id,
      isOuter: false,
    });
  }

  // Identify the outer face: it has the most negative signed area (clockwise traversal)
  let outerFaceIdx = 0;
  let minArea = Infinity;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    let area = 0;
    let current = halfEdges.get(face.halfEdge);
    if (!current) continue;

    const startId = current.id;
    do {
      const o = nodeMap.get(current!.origin);
      const t = nodeMap.get(current!.target);
      if (o && t) {
        area += (o.x * t.y - t.x * o.y);
      }
      current = halfEdges.get(current!.next)!;
    } while (current && current.id !== startId);

    area /= 2;

    // The outer face is traversed clockwise → negative signed area
    if (area < minArea) {
      minArea = area;
      outerFaceIdx = fi;
    }
  }

  if (faces.length > 0) {
    faces[outerFaceIdx].isOuter = true;
  }

  return { halfEdges, faces };
}
