/**
 * Preset grammar rules for structural shape generation.
 *
 * Each rule defines:
 *  - findMatches(): where in the diagram it can be applied
 *  - apply(): how it transforms the diagram
 *
 * Rules operate on the form diagram; the equilibrium engine recomputes
 * forces automatically after each application.
 */

import { DiagramData, DiagramNode, DiagramEdge, ElementType } from '../types';
import { GrammarRule, RuleMatch } from './types';
import { generateId } from '../utils/id';
import { sub, add, scale, normalize, length, perp, angle } from '../engine/geometry';

// ─── Helper: clone diagram ───────────────────────────────────────

function cloneDiagram(d: DiagramData): DiagramData {
  return {
    nodes: d.nodes.map((n) => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: d.edges.map((e) => ({ ...e })),
  };
}

function newEdge(source: string, target: string, elementType: ElementType = 'compression'): DiagramEdge {
  return { id: generateId('e'), source, target, elementType, plateWidth: 0.3, plateThickness: 3 };
}

// ─── Helper: get adjacent edges for a node ───────────────────────

function adjacentEdges(edges: DiagramEdge[], nodeId: string): DiagramEdge[] {
  return edges.filter((e) => e.source === nodeId || e.target === nodeId);
}

function otherEnd(edge: DiagramEdge, nodeId: string): string {
  return edge.source === nodeId ? edge.target : edge.source;
}

// ═════════════════════════════════════════════════════════════════
// RULE 1: Edge Subdivision
// Split an edge into two edges with a new node in between.
//   LHS: —A————B—
//   RHS: —A——C——B—
// ═════════════════════════════════════════════════════════════════

const edgeSubdivision: GrammarRule = {
  id: 'subdivision',
  name: 'Subdivision',
  description: 'Split an edge into two by inserting a new node. Optionally offset the node perpendicular to the edge.',
  category: 'subdivision',
  icon: '⊥',
  parameters: [
    { key: 't', label: 'Position (0–1)', min: 0.1, max: 0.9, step: 0.05, defaultValue: 0.5 },
    { key: 'offset', label: 'Perpendicular offset', min: -3, max: 3, step: 0.1, defaultValue: 0 },
  ],

  findMatches(diagram: DiagramData): RuleMatch[] {
    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    return diagram.edges.map((edge) => {
      const src = nodeMap.get(edge.source)!;
      const tgt = nodeMap.get(edge.target)!;
      return {
        ruleId: 'subdivision',
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        position: { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 },
        label: `Edge (${src.x},${src.y})→(${tgt.x},${tgt.y})`,
      };
    });
  },

  apply(diagram: DiagramData, match: RuleMatch, params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const t = params.t ?? 0.5;
    const offset = params.offset ?? 0;
    const edgeId = match.edgeIds[0];
    const edgeIdx = d.edges.findIndex((e) => e.id === edgeId);
    if (edgeIdx === -1) return d;

    const edge = d.edges[edgeIdx];
    const nodeMap = new Map(d.nodes.map((n) => [n.id, n]));
    const src = nodeMap.get(edge.source)!;
    const tgt = nodeMap.get(edge.target)!;

    // Compute new node position
    const dir = sub({ x: tgt.x, y: tgt.y }, { x: src.x, y: src.y });
    const p = perp(normalize(dir));
    const mid = add(
      add({ x: src.x, y: src.y }, scale(dir, t)),
      scale(p, offset)
    );

    const newNodeId = generateId('n');
    const newNode: DiagramNode = {
      id: newNodeId,
      x: mid.x,
      y: mid.y,
      support: 'free',
      externalForce: { x: 0, y: 0 },
    };

    // Remove original edge, add two new edges inheriting plate properties
    d.edges.splice(edgeIdx, 1);
    d.edges.push({ ...newEdge(edge.source, newNodeId, edge.elementType), plateWidth: edge.plateWidth, plateThickness: edge.plateThickness });
    d.edges.push({ ...newEdge(newNodeId, edge.target, edge.elementType), plateWidth: edge.plateWidth, plateThickness: edge.plateThickness });
    d.nodes.push(newNode);

    return d;
  },
};

// ═════════════════════════════════════════════════════════════════
// RULE 2: Branching
// Add a new member extending from an existing node.
//   LHS: ●
//   RHS: ●——○
// ═════════════════════════════════════════════════════════════════

const branching: GrammarRule = {
  id: 'branching',
  name: 'Branching',
  description: 'Add a new member extending from an existing node at a given angle and length.',
  category: 'branching',
  icon: '⟨',
  parameters: [
    { key: 'angle', label: 'Angle (degrees)', min: 0, max: 360, step: 15, defaultValue: 90 },
    { key: 'length', label: 'Length', min: 0.5, max: 5, step: 0.25, defaultValue: 1.5 },
  ],

  findMatches(diagram: DiagramData): RuleMatch[] {
    return diagram.nodes.map((node) => ({
      ruleId: 'branching',
      nodeIds: [node.id],
      edgeIds: [],
      position: { x: node.x, y: node.y },
      label: `Node (${node.x},${node.y})`,
    }));
  },

  apply(diagram: DiagramData, match: RuleMatch, params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const nodeId = match.nodeIds[0];
    const node = d.nodes.find((n) => n.id === nodeId);
    if (!node) return d;

    const angleDeg = params.angle ?? 90;
    const len = params.length ?? 1.5;
    const rad = (angleDeg * Math.PI) / 180;

    const newNodeId = generateId('n');
    d.nodes.push({
      id: newNodeId,
      x: node.x + len * Math.cos(rad),
      y: node.y + len * Math.sin(rad),
      support: 'free',
      externalForce: { x: 0, y: 0 },
    });
    d.edges.push(newEdge(nodeId, newNodeId));

    return d;
  },
};

// ═════════════════════════════════════════════════════════════════
// RULE 3: Extension
// Extend a free node (degree ≤ 2) outward.
//   LHS: —●  (free end)
//   RHS: —●——○
// ═════════════════════════════════════════════════════════════════

const extension: GrammarRule = {
  id: 'extension',
  name: 'Extension',
  description: 'Extend a free-end node outward along a parameterized direction.',
  category: 'extension',
  icon: '→',
  parameters: [
    { key: 'angleOffset', label: 'Angle offset (deg)', min: -180, max: 180, step: 15, defaultValue: 0 },
    { key: 'length', label: 'Length', min: 0.5, max: 5, step: 0.25, defaultValue: 1.5 },
  ],

  findMatches(diagram: DiagramData): RuleMatch[] {
    const matches: RuleMatch[] = [];
    for (const node of diagram.nodes) {
      if (node.support !== 'free') continue;
      const adj = adjacentEdges(diagram.edges, node.id);
      if (adj.length === 0 || adj.length > 2) continue;
      matches.push({
        ruleId: 'extension',
        nodeIds: [node.id],
        edgeIds: adj.map((e) => e.id),
        position: { x: node.x, y: node.y },
        label: `Free node (${node.x},${node.y})`,
      });
    }
    return matches;
  },

  apply(diagram: DiagramData, match: RuleMatch, params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const nodeId = match.nodeIds[0];
    const node = d.nodes.find((n) => n.id === nodeId);
    if (!node) return d;

    const adj = adjacentEdges(d.edges, nodeId);
    const angleOff = ((params.angleOffset ?? 0) * Math.PI) / 180;
    const len = params.length ?? 1.5;

    // Compute average direction AWAY from neighbors
    let avgDx = 0, avgDy = 0;
    const nodeMap = new Map(d.nodes.map((n) => [n.id, n]));
    for (const e of adj) {
      const other = nodeMap.get(otherEnd(e, nodeId));
      if (!other) continue;
      avgDx += node.x - other.x;
      avgDy += node.y - other.y;
    }
    const outAngle = Math.atan2(avgDy, avgDx) + angleOff;

    const newNodeId = generateId('n');
    d.nodes.push({
      id: newNodeId,
      x: node.x + len * Math.cos(outAngle),
      y: node.y + len * Math.sin(outAngle),
      support: 'free',
      externalForce: { x: 0, y: 0 },
    });
    d.edges.push({
      ...newEdge(nodeId, newNodeId),
    });

    return d;
  },
};

// ═════════════════════════════════════════════════════════════════
// RULE 4: Triangulation
// Connect two nodes that share a common neighbor but are not directly connected.
//   LHS: A—●—B  (V-shape)
//   RHS: A—●—B + A——B  (triangle)
// ═════════════════════════════════════════════════════════════════

const triangulation: GrammarRule = {
  id: 'triangulation',
  name: 'Triangulation',
  description: 'Close a V-shape by adding an edge between two nodes that share a common neighbor.',
  category: 'triangulation',
  icon: '△',
  parameters: [],

  findMatches(diagram: DiagramData): RuleMatch[] {
    const matches: RuleMatch[] = [];
    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    const edgeSet = new Set(
      diagram.edges.map((e) => [e.source, e.target].sort().join(':'))
    );

    for (const node of diagram.nodes) {
      const adj = adjacentEdges(diagram.edges, node.id);
      const neighbors = adj.map((e) => otherEnd(e, node.id));

      // Check all pairs of neighbors
      for (let i = 0; i < neighbors.length; i++) {
        for (let j = i + 1; j < neighbors.length; j++) {
          const a = neighbors[i];
          const b = neighbors[j];
          const edgeKey = [a, b].sort().join(':');
          if (edgeSet.has(edgeKey)) continue; // already connected

          const na = nodeMap.get(a);
          const nb = nodeMap.get(b);
          if (!na || !nb) continue;

          matches.push({
            ruleId: 'triangulation',
            nodeIds: [node.id, a, b],
            edgeIds: [],
            position: {
              x: (node.x + na.x + nb.x) / 3,
              y: (node.y + na.y + nb.y) / 3,
            },
            label: `V at (${node.x},${node.y}): (${na.x},${na.y})↔(${nb.x},${nb.y})`,
          });
        }
      }
    }
    return matches;
  },

  apply(diagram: DiagramData, match: RuleMatch, _params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const [_center, a, b] = match.nodeIds;
    // Check not already connected
    const exists = d.edges.some(
      (e) =>
        (e.source === a && e.target === b) ||
        (e.source === b && e.target === a)
    );
    if (exists) return d;

    d.edges.push(newEdge(a, b));
    return d;
  },
};

// ═════════════════════════════════════════════════════════════════
// RULE 5: Edge Removal
// Remove an edge without disconnecting the graph.
//   LHS: —A————B—  (redundant edge)
//   RHS: —A    B—
// ═════════════════════════════════════════════════════════════════

const edgeRemoval: GrammarRule = {
  id: 'removal',
  name: 'Edge Removal',
  description: 'Remove an edge. Only available for edges whose removal does not disconnect the graph.',
  category: 'removal',
  icon: '✂',
  parameters: [],

  findMatches(diagram: DiagramData): RuleMatch[] {
    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    const matches: RuleMatch[] = [];

    for (const edge of diagram.edges) {
      // Check if removing this edge disconnects the graph
      const remaining = diagram.edges.filter((e) => e.id !== edge.id);
      if (isConnected(diagram.nodes, remaining)) {
        const src = nodeMap.get(edge.source)!;
        const tgt = nodeMap.get(edge.target)!;
        matches.push({
          ruleId: 'removal',
          nodeIds: [edge.source, edge.target],
          edgeIds: [edge.id],
          position: { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 },
          label: `Edge (${src.x},${src.y})→(${tgt.x},${tgt.y})`,
        });
      }
    }
    return matches;
  },

  apply(diagram: DiagramData, match: RuleMatch, _params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const edgeId = match.edgeIds[0];
    d.edges = d.edges.filter((e) => e.id !== edgeId);
    // Also remove isolated nodes
    const connectedNodeIds = new Set<string>();
    for (const e of d.edges) {
      connectedNodeIds.add(e.source);
      connectedNodeIds.add(e.target);
    }
    // Keep supported nodes and nodes with edges
    d.nodes = d.nodes.filter((n) => connectedNodeIds.has(n.id) || n.support !== 'free');
    return d;
  },
};

// ═════════════════════════════════════════════════════════════════
// RULE 6: Parallel Offset
// Duplicate an edge at a perpendicular offset, creating a quad.
//   LHS: —A————B—
//   RHS: —A————B— + A'———B' + A—A' + B—B'
// ═════════════════════════════════════════════════════════════════

const parallelOffset: GrammarRule = {
  id: 'parallel-offset',
  name: 'Parallel Offset',
  description: 'Duplicate an edge at a perpendicular offset and connect endpoints, forming a quadrilateral.',
  category: 'branching',
  icon: '▭',
  parameters: [
    { key: 'offset', label: 'Offset distance', min: 0.5, max: 4, step: 0.25, defaultValue: 1 },
  ],

  findMatches(diagram: DiagramData): RuleMatch[] {
    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    return diagram.edges.map((edge) => {
      const src = nodeMap.get(edge.source)!;
      const tgt = nodeMap.get(edge.target)!;
      return {
        ruleId: 'parallel-offset',
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        position: { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 },
        label: `Edge (${src.x},${src.y})→(${tgt.x},${tgt.y})`,
      };
    });
  },

  apply(diagram: DiagramData, match: RuleMatch, params: Record<string, number>): DiagramData {
    const d = cloneDiagram(diagram);
    const offset = params.offset ?? 1;
    const srcNode = d.nodes.find((n) => n.id === match.nodeIds[0]);
    const tgtNode = d.nodes.find((n) => n.id === match.nodeIds[1]);
    if (!srcNode || !tgtNode) return d;

    const dir = sub({ x: tgtNode.x, y: tgtNode.y }, { x: srcNode.x, y: srcNode.y });
    const p = scale(normalize(perp(dir)), offset);

    const newSrcId = generateId('n');
    const newTgtId = generateId('n');
    d.nodes.push({
      id: newSrcId,
      x: srcNode.x + p.x,
      y: srcNode.y + p.y,
      support: 'free',
      externalForce: { x: 0, y: 0 },
    });
    d.nodes.push({
      id: newTgtId,
      x: tgtNode.x + p.x,
      y: tgtNode.y + p.y,
      support: 'free',
      externalForce: { x: 0, y: 0 },
    });
    // Parallel edge
    d.edges.push(newEdge(newSrcId, newTgtId));
    // Connecting edges
    d.edges.push(newEdge(match.nodeIds[0], newSrcId));
    d.edges.push(newEdge(match.nodeIds[1], newTgtId));

    return d;
  },
};

// ─── Utility: graph connectivity check ───────────────────────────

function isConnected(nodes: DiagramNode[], edges: DiagramEdge[]): boolean {
  if (nodes.length <= 1) return true;

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  const visited = new Set<string>();
  const queue = [nodes[0].id];
  visited.add(nodes[0].id);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adj.get(current) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Only check nodes that have at least one edge
  const nodesWithEdges = new Set<string>();
  for (const e of edges) {
    nodesWithEdges.add(e.source);
    nodesWithEdges.add(e.target);
  }
  for (const nid of nodesWithEdges) {
    if (!visited.has(nid)) return false;
  }
  return true;
}

// ─── Export all preset rules ─────────────────────────────────────

export const presetRules: GrammarRule[] = [
  edgeSubdivision,
  branching,
  extension,
  triangulation,
  edgeRemoval,
  parallelOffset,
];
