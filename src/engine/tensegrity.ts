/**
 * Tensegrity validation and fabrication info computation.
 *
 * Checks:
 * 1. All compression members (plates) are non-touching
 *    (no two compression members share a node)
 * 2. The tension network (cables only) is connected
 * 3. At least one compression and one tension member exist
 *
 * Also computes plate corners and cable lengths for fabrication.
 */

import {
  DiagramData,
  DiagramNode,
  DiagramEdge,
  TensegrityResult,
  PlateInfo,
  CableInfo,
  Vec2,
} from '../types';
import { sub, add, scale, normalize, length, perp } from './geometry';

export function validateTensegrity(diagram: DiagramData): TensegrityResult {
  const { nodes, edges } = diagram;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const compressionEdges = edges.filter((e) => e.elementType === 'compression');
  const tensionEdges = edges.filter((e) => e.elementType === 'tension');

  const issues: string[] = [];

  // Basic counts
  if (compressionEdges.length === 0) {
    issues.push('No compression members (plates) defined');
  }
  if (tensionEdges.length === 0) {
    issues.push('No tension members (cables) defined');
  }

  // Check 1: No two compression members share a node
  const compressionNodeCount = new Map<string, number>();
  for (const e of compressionEdges) {
    compressionNodeCount.set(e.source, (compressionNodeCount.get(e.source) || 0) + 1);
    compressionNodeCount.set(e.target, (compressionNodeCount.get(e.target) || 0) + 1);
  }
  for (const [nodeId, count] of compressionNodeCount) {
    if (count > 1) {
      const node = nodeMap.get(nodeId);
      const pos = node ? `(${node.x},${node.y})` : nodeId;
      issues.push(`Node ${pos} connects ${count} compression members — plates must not touch`);
    }
  }

  // Check 2: Tension network connectivity
  if (tensionEdges.length > 0) {
    // Build adjacency for tension-only subgraph
    const tensionNodes = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const e of tensionEdges) {
      tensionNodes.add(e.source);
      tensionNodes.add(e.target);
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }

    // BFS from first tension node
    const visited = new Set<string>();
    const start = tensionNodes.values().next().value;
    if (start) {
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const neighbor of adj.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      const disconnectedCount = tensionNodes.size - visited.size;
      if (disconnectedCount > 0) {
        issues.push(`Tension network is disconnected (${disconnectedCount} unreachable nodes)`);
      }
    }

    // Check that all compression endpoints are part of the tension network
    for (const e of compressionEdges) {
      if (!tensionNodes.has(e.source)) {
        const node = nodeMap.get(e.source);
        issues.push(`Compression endpoint (${node?.x},${node?.y}) not connected to tension network`);
      }
      if (!tensionNodes.has(e.target)) {
        const node = nodeMap.get(e.target);
        issues.push(`Compression endpoint (${node?.x},${node?.y}) not connected to tension network`);
      }
    }
  }

  // Check 3: Compression members don't overlap geometrically
  for (let i = 0; i < compressionEdges.length; i++) {
    for (let j = i + 1; j < compressionEdges.length; j++) {
      const ei = compressionEdges[i];
      const ej = compressionEdges[j];
      if (platesOverlap(ei, ej, nodeMap)) {
        issues.push(`Plates "${plateLabel(ei, nodeMap)}" and "${plateLabel(ej, nodeMap)}" may overlap`);
      }
    }
  }

  // Compute plate info
  const plates: PlateInfo[] = compressionEdges.map((e, i) => {
    const src = nodeMap.get(e.source)!;
    const tgt = nodeMap.get(e.target)!;
    const dx = tgt.x - src.x, dy = tgt.y - src.y, dz = tgt.z - src.z;
    const len3d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const corners = getPlateCorners(e, nodeMap) || [
      { x: src.x, y: src.y }, { x: tgt.x, y: tgt.y },
      { x: tgt.x, y: tgt.y }, { x: src.x, y: src.y },
    ];

    return {
      edgeId: e.id,
      label: `P${i + 1}`,
      length: len3d,
      width: e.plateWidth,
      thickness: e.plateThickness,
      corners: corners as [Vec2, Vec2, Vec2, Vec2],
    };
  });

  // Compute cable info
  const cables: CableInfo[] = tensionEdges.map((e, i) => {
    const src = nodeMap.get(e.source)!;
    const tgt = nodeMap.get(e.target)!;
    const d = sub({ x: tgt.x, y: tgt.y }, { x: src.x, y: src.y });
    return {
      edgeId: e.id,
      label: `C${i + 1}`,
      length: length(d),
      sourceNodeId: e.source,
      targetNodeId: e.target,
    };
  });

  return {
    isValid: issues.length === 0 && compressionEdges.length > 0 && tensionEdges.length > 0,
    compressionCount: compressionEdges.length,
    tensionCount: tensionEdges.length,
    issues,
    plates,
    cables,
  };
}

function plateLabel(e: DiagramEdge, nodeMap: Map<string, DiagramNode>): string {
  const src = nodeMap.get(e.source);
  const tgt = nodeMap.get(e.target);
  return `(${src?.x},${src?.y})→(${tgt?.x},${tgt?.y})`;
}

/** Rough overlap check — skip if plates are at different z levels */
function platesOverlap(
  a: DiagramEdge,
  b: DiagramEdge,
  nodeMap: Map<string, DiagramNode>
): boolean {
  const srcA = nodeMap.get(a.source), tgtA = nodeMap.get(a.target);
  const srcB = nodeMap.get(b.source), tgtB = nodeMap.get(b.target);
  if (!srcA || !tgtA || !srcB || !tgtB) return false;

  // If the z-ranges don't overlap, plates can't collide
  const zA = [srcA.z, tgtA.z], zB = [srcB.z, tgtB.z];
  const minZA = Math.min(...zA), maxZA = Math.max(...zA);
  const minZB = Math.min(...zB), maxZB = Math.max(...zB);
  if (maxZA < minZB - 0.05 || maxZB < minZA - 0.05) return false;

  const cornersA = getPlateCorners(a, nodeMap);
  const cornersB = getPlateCorners(b, nodeMap);
  if (!cornersA || !cornersB) return false;

  return satOverlap(cornersA, cornersB);
}

function getPlateCorners(
  e: DiagramEdge,
  nodeMap: Map<string, DiagramNode>
): [Vec2, Vec2, Vec2, Vec2] | null {
  const src = nodeMap.get(e.source);
  const tgt = nodeMap.get(e.target);
  if (!src || !tgt) return null;

  const d = sub({ x: tgt.x, y: tgt.y }, { x: src.x, y: src.y });
  const len = length(d);
  if (len < 1e-6) {
    // Vertical plate — use a default direction for the XY outline
    const hw = e.plateWidth / 2;
    return [
      { x: src.x - hw, y: src.y - hw },
      { x: src.x + hw, y: src.y - hw },
      { x: src.x + hw, y: src.y + hw },
      { x: src.x - hw, y: src.y + hw },
    ];
  }
  const p = scale(normalize(perp(d)), e.plateWidth / 2);

  return [
    add({ x: src.x, y: src.y }, p),
    add({ x: tgt.x, y: tgt.y }, p),
    sub({ x: tgt.x, y: tgt.y }, p),
    sub({ x: src.x, y: src.y }, p),
  ];
}

function satOverlap(a: Vec2[], b: Vec2[]): boolean {
  const axes = getAxes(a).concat(getAxes(b));
  for (const axis of axes) {
    const [minA, maxA] = project(a, axis);
    const [minB, maxB] = project(b, axis);
    if (maxA < minB + 0.01 || maxB < minA + 0.01) return false;
  }
  return true;
}

function getAxes(corners: Vec2[]): Vec2[] {
  const axes: Vec2[] = [];
  for (let i = 0; i < corners.length; i++) {
    const j = (i + 1) % corners.length;
    const edge = sub(corners[j], corners[i]);
    axes.push(normalize(perp(edge)));
  }
  return axes;
}

function project(corners: Vec2[], axis: Vec2): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const val = c.x * axis.x + c.y * axis.y;
    min = Math.min(min, val);
    max = Math.max(max, val);
  }
  return [min, max];
}
