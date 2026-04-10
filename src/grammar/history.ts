/**
 * Derivation history tree.
 * Tracks grammar rule applications as a tree structure,
 * allowing backtracking and branching exploration.
 */

import { DiagramData } from '../types';
import { HistoryTree, HistoryNode } from './types';
import { generateId } from '../utils/id';

function cloneDiagram(d: DiagramData): DiagramData {
  return {
    nodes: d.nodes.map((n) => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: d.edges.map((e) => ({ ...e })),
  };
}

/** Create a new history tree with the initial diagram as root. */
export function createHistoryTree(diagram: DiagramData): HistoryTree {
  const rootId = generateId('hist');
  const root: HistoryNode = {
    id: rootId,
    diagram: cloneDiagram(diagram),
    ruleApplied: null,
    parentId: null,
    childIds: [],
  };
  const nodes = new Map<string, HistoryNode>();
  nodes.set(rootId, root);
  return { nodes, rootId, currentId: rootId };
}

/** Add a new node to the history tree after applying a grammar rule. */
export function addHistoryNode(
  tree: HistoryTree,
  newDiagram: DiagramData,
  ruleInfo: { ruleId: string; ruleName: string; matchLabel: string }
): HistoryTree {
  const newId = generateId('hist');
  const parentNode = tree.nodes.get(tree.currentId);
  if (!parentNode) return tree;

  const newNode: HistoryNode = {
    id: newId,
    diagram: cloneDiagram(newDiagram),
    ruleApplied: ruleInfo,
    parentId: tree.currentId,
    childIds: [],
  };

  // Clone the tree
  const nodes = new Map(tree.nodes);
  // Update parent's children
  const updatedParent = { ...parentNode, childIds: [...parentNode.childIds, newId] };
  nodes.set(tree.currentId, updatedParent);
  nodes.set(newId, newNode);

  return { ...tree, nodes, currentId: newId };
}

/** Navigate to a different node in the history tree. */
export function navigateHistory(tree: HistoryTree, targetId: string): HistoryTree {
  if (!tree.nodes.has(targetId)) return tree;
  return { ...tree, currentId: targetId };
}

/** Get the path from root to a given node. */
export function getPathToNode(tree: HistoryTree, nodeId: string): HistoryNode[] {
  const path: HistoryNode[] = [];
  let current = tree.nodes.get(nodeId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? tree.nodes.get(current.parentId) : undefined;
  }
  return path;
}

/** Get the depth of a node in the tree. */
export function getNodeDepth(tree: HistoryTree, nodeId: string): number {
  let depth = 0;
  let current = tree.nodes.get(nodeId);
  while (current?.parentId) {
    depth++;
    current = tree.nodes.get(current.parentId);
  }
  return depth;
}

/** Get all leaf nodes (no children). */
export function getLeafNodes(tree: HistoryTree): HistoryNode[] {
  return Array.from(tree.nodes.values()).filter((n) => n.childIds.length === 0);
}

/** Collect all nodes in BFS order for rendering. */
export function getTreeLayout(tree: HistoryTree): { node: HistoryNode; depth: number; index: number }[] {
  const result: { node: HistoryNode; depth: number; index: number }[] = [];
  const queue: { id: string; depth: number }[] = [{ id: tree.rootId, depth: 0 }];
  const depthCounters = new Map<number, number>();

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const node = tree.nodes.get(id);
    if (!node) continue;

    const index = depthCounters.get(depth) || 0;
    depthCounters.set(depth, index + 1);
    result.push({ node, depth, index });

    for (const childId of node.childIds) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }

  return result;
}
