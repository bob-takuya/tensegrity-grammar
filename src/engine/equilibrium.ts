/**
 * Equilibrium solver for 2D truss structures.
 *
 * Builds the equilibrium matrix and solves for member forces and reactions.
 * Convention: positive force = tension, negative = compression.
 */

import { DiagramNode, DiagramEdge, EquilibriumResult, Vec2 } from '../types';
import { sub, length } from './geometry';
import { solve } from './linalg';

export function computeEquilibrium(
  nodes: DiagramNode[],
  edges: DiagramEdge[]
): EquilibriumResult {
  if (nodes.length === 0 || edges.length === 0) {
    return {
      forces: new Map(),
      reactions: new Map(),
      status: 'no-structure',
      residual: 0,
    };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Identify free DOFs and reaction DOFs
  const freeNodes = nodes.filter((n) => n.support === 'free');
  const supportedNodes = nodes.filter((n) => n.support !== 'free');

  // Count reaction components
  let reactionCount = 0;
  const reactionInfo: { nodeId: string; component: 'x' | 'y'; index: number }[] = [];
  for (const n of supportedNodes) {
    if (n.support === 'pin') {
      reactionInfo.push({ nodeId: n.id, component: 'x', index: reactionCount++ });
      reactionInfo.push({ nodeId: n.id, component: 'y', index: reactionCount++ });
    } else if (n.support === 'roller-x') {
      // Roller on x-axis: vertical reaction only
      reactionInfo.push({ nodeId: n.id, component: 'y', index: reactionCount++ });
    } else if (n.support === 'roller-y') {
      // Roller on y-axis: horizontal reaction only
      reactionInfo.push({ nodeId: n.id, component: 'x', index: reactionCount++ });
    }
  }

  // All nodes participate in equilibrium
  const allNodes = nodes;
  const nodeIndexMap = new Map(allNodes.map((n, i) => [n.id, i]));
  const numEqs = 2 * allNodes.length; // 2 equations per node
  const numMembers = edges.length;
  const numUnknowns = numMembers + reactionCount;

  if (numEqs === 0 || numUnknowns === 0) {
    return {
      forces: new Map(),
      reactions: new Map(),
      status: 'no-structure',
      residual: 0,
    };
  }

  // Build the equilibrium matrix [A_members | A_reactions] * [f; R] = p
  const A: number[][] = Array.from({ length: numEqs }, () =>
    new Array(numUnknowns).fill(0)
  );
  const p: number[] = new Array(numEqs).fill(0);

  // Member contributions
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    const nSrc = nodeMap.get(edge.source);
    const nTgt = nodeMap.get(edge.target);
    if (!nSrc || !nTgt) continue;

    const iSrc = nodeIndexMap.get(edge.source)!;
    const iTgt = nodeIndexMap.get(edge.target)!;

    const d = sub({ x: nTgt.x, y: nTgt.y }, { x: nSrc.x, y: nSrc.y });
    const len = length(d);
    if (len < 1e-10) continue;

    const cx = d.x / len; // direction cosine x
    const cy = d.y / len; // direction cosine y

    // Force on source node (tension pulls toward target)
    A[2 * iSrc][e] = cx;
    A[2 * iSrc + 1][e] = cy;

    // Force on target node (tension pulls toward source)
    A[2 * iTgt][e] = -cx;
    A[2 * iTgt + 1][e] = -cy;
  }

  // Reaction contributions
  for (const ri of reactionInfo) {
    const ni = nodeIndexMap.get(ri.nodeId);
    if (ni === undefined) continue;
    const col = numMembers + ri.index;
    if (ri.component === 'x') {
      A[2 * ni][col] = 1;
    } else {
      A[2 * ni + 1][col] = 1;
    }
  }

  // External forces (RHS)
  for (const n of allNodes) {
    const i = nodeIndexMap.get(n.id)!;
    p[2 * i] = -n.externalForce.x;
    p[2 * i + 1] = -n.externalForce.y;
  }

  // Solve
  const solution = solve(A, p);

  if (!solution) {
    // Check if indeterminate or unstable
    const status = numUnknowns > numEqs ? 'indeterminate' : 'unstable';
    return {
      forces: new Map(),
      reactions: new Map(),
      status,
      residual: Infinity,
    };
  }

  // Extract member forces
  const forces = new Map<string, number>();
  for (let e = 0; e < edges.length; e++) {
    forces.set(edges[e].id, solution[e]);
  }

  // Extract reactions
  const reactionVecs = new Map<string, Vec2>();
  for (const ri of reactionInfo) {
    if (!reactionVecs.has(ri.nodeId)) {
      reactionVecs.set(ri.nodeId, { x: 0, y: 0 });
    }
    const rv = reactionVecs.get(ri.nodeId)!;
    if (ri.component === 'x') rv.x = solution[numMembers + ri.index];
    else rv.y = solution[numMembers + ri.index];
  }

  // Compute residual (check equilibrium at each node)
  let maxResidual = 0;
  for (const n of allNodes) {
    const i = nodeIndexMap.get(n.id)!;
    let rx = n.externalForce.x;
    let ry = n.externalForce.y;

    // Add member forces
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      const f = solution[e];
      const nSrc = nodeMap.get(edge.source)!;
      const nTgt = nodeMap.get(edge.target)!;
      const d = sub({ x: nTgt.x, y: nTgt.y }, { x: nSrc.x, y: nSrc.y });
      const len = length(d);
      if (len < 1e-10) continue;

      if (edge.source === n.id) {
        rx += f * (d.x / len);
        ry += f * (d.y / len);
      } else if (edge.target === n.id) {
        rx -= f * (d.x / len);
        ry -= f * (d.y / len);
      }
    }

    // Add reactions
    const rv = reactionVecs.get(n.id);
    if (rv) {
      rx += rv.x;
      ry += rv.y;
    }

    maxResidual = Math.max(maxResidual, Math.abs(rx), Math.abs(ry));
  }

  return {
    forces,
    reactions: reactionVecs,
    status: maxResidual < 0.01 ? 'determinate' : 'unstable',
    residual: maxResidual,
  };
}
