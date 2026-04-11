/**
 * 3D Equilibrium solver for truss / tensegrity structures.
 *
 * Builds the 3D equilibrium matrix and solves for member forces and reactions.
 * Convention: positive force = tension, negative = compression.
 *
 * Supports:
 *  - Determinate structures (exact solve)
 *  - Indeterminate structures (minimum-norm solution)
 *  - 3D: 3 equations per node (x, y, z)
 */

import { DiagramNode, DiagramEdge, EquilibriumResult, Vec2 } from '../types';
import { solve, findNullspaceBasis } from './linalg';

export function computeEquilibrium(
  nodes: DiagramNode[],
  edges: DiagramEdge[]
): EquilibriumResult {
  if (nodes.length === 0 || edges.length === 0) {
    return { forces: new Map(), reactions: new Map(), status: 'no-structure', residual: 0 };
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const supportedNodes = nodes.filter(n => n.support !== 'free');

  // Determine if structure is 3D (any node with z ≠ 0)
  const is3D = nodes.some(n => Math.abs(n.z) > 0.01);
  const dim = is3D ? 3 : 2;

  // Reaction components
  let reactionCount = 0;
  const reactionInfo: { nodeId: string; component: 'x' | 'y' | 'z'; index: number }[] = [];
  for (const n of supportedNodes) {
    if (n.support === 'pin') {
      reactionInfo.push({ nodeId: n.id, component: 'x', index: reactionCount++ });
      reactionInfo.push({ nodeId: n.id, component: 'y', index: reactionCount++ });
      if (is3D) reactionInfo.push({ nodeId: n.id, component: 'z', index: reactionCount++ });
    } else if (n.support === 'roller-x') {
      reactionInfo.push({ nodeId: n.id, component: 'y', index: reactionCount++ });
      if (is3D) reactionInfo.push({ nodeId: n.id, component: 'z', index: reactionCount++ });
    } else if (n.support === 'roller-y') {
      reactionInfo.push({ nodeId: n.id, component: 'x', index: reactionCount++ });
      if (is3D) reactionInfo.push({ nodeId: n.id, component: 'z', index: reactionCount++ });
    }
  }

  const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));
  const numEqs = dim * nodes.length;
  const numMembers = edges.length;
  const numUnknowns = numMembers + reactionCount;

  if (numEqs === 0 || numUnknowns === 0) {
    return { forces: new Map(), reactions: new Map(), status: 'no-structure', residual: 0 };
  }

  // Build equilibrium matrix
  const A: number[][] = Array.from({ length: numEqs }, () => new Array(numUnknowns).fill(0));
  const p: number[] = new Array(numEqs).fill(0);

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    const nSrc = nodeMap.get(edge.source);
    const nTgt = nodeMap.get(edge.target);
    if (!nSrc || !nTgt) continue;

    const iSrc = nodeIndexMap.get(edge.source)!;
    const iTgt = nodeIndexMap.get(edge.target)!;

    const dx = nTgt.x - nSrc.x;
    const dy = nTgt.y - nSrc.y;
    const dz = nTgt.z - nSrc.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) continue;

    const cx = dx / len, cy = dy / len, cz = dz / len;

    // Source node: tension pulls toward target
    A[dim * iSrc + 0][e] = cx;
    A[dim * iSrc + 1][e] = cy;
    if (is3D) A[dim * iSrc + 2][e] = cz;

    // Target node: tension pulls toward source
    A[dim * iTgt + 0][e] = -cx;
    A[dim * iTgt + 1][e] = -cy;
    if (is3D) A[dim * iTgt + 2][e] = -cz;
  }

  // Reaction contributions
  for (const ri of reactionInfo) {
    const ni = nodeIndexMap.get(ri.nodeId);
    if (ni === undefined) continue;
    const col = numMembers + ri.index;
    const compIdx = ri.component === 'x' ? 0 : ri.component === 'y' ? 1 : 2;
    A[dim * ni + compIdx][col] = 1;
  }

  // External forces (RHS) — gravity acts in -z for 3D, -y for 2D
  for (const n of nodes) {
    const i = nodeIndexMap.get(n.id)!;
    p[dim * i + 0] = -n.externalForce.x;
    p[dim * i + 1] = -n.externalForce.y;
    // z-component: no user-applied z-force currently, but gravity can add via prepareAndSolve
  }

  // Solve (handles square, over-determined, AND under-determined)
  let solution = solve(A, p);

  if (!solution) {
    return { forces: new Map(), reactions: new Map(), status: 'unstable', residual: Infinity };
  }

  // For under-determined systems (tensegrity): add self-stress (prestress)
  // so that cables are in tension (+) and struts in compression (−).
  //
  // The general solution is: f = f_particular + Σ αᵢ × nᵢ
  // where nᵢ are nullspace basis vectors of A.
  //
  // We iteratively adjust αᵢ to fix sign violations.
  if (numEqs < numUnknowns) {
    const basis = findNullspaceBasis(A);
    if (basis.length > 0) {
      const alphas = new Array(basis.length).fill(0);

      // Iterative sign correction (simple gradient descent)
      for (let iter = 0; iter < 200; iter++) {
        // Compute current forces
        const f = solution.map((s, i) => {
          let val = s;
          for (let k = 0; k < basis.length; k++) val += alphas[k] * (basis[k][i] || 0);
          return val;
        });

        // Find worst violation (only among member forces, not reactions)
        let worstIdx = -1, worstViolation = 0;
        for (let e = 0; e < edges.length; e++) {
          const isCable = edges[e].elementType === 'tension';
          const violation = isCable ? Math.max(0, -f[e]) : Math.max(0, f[e]);
          if (violation > worstViolation) { worstViolation = violation; worstIdx = e; }
        }

        if (worstViolation < 0.001) break; // all signs correct

        // Adjust alphas to fix the worst violation
        const isCable = edges[worstIdx].elementType === 'tension';
        const target = isCable ? 0.01 : -0.01; // desired sign
        const deficit = target - f[worstIdx];

        // Find which basis vector has the largest component for this member
        let bestK = 0, bestComp = 0;
        for (let k = 0; k < basis.length; k++) {
          if (Math.abs(basis[k][worstIdx]) > bestComp) {
            bestComp = Math.abs(basis[k][worstIdx]);
            bestK = k;
          }
        }
        if (bestComp > 1e-10) {
          alphas[bestK] += deficit / basis[bestK][worstIdx];
        }
      }

      // Apply final alphas
      solution = solution.map((s, i) => {
        let val = s;
        for (let k = 0; k < basis.length; k++) val += alphas[k] * (basis[k][i] || 0);
        return val;
      });
    }
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
    else if (ri.component === 'y') rv.y = solution[numMembers + ri.index];
    // z reactions not stored in Vec2 (TODO: extend if needed)
  }

  // Compute residual
  let maxResidual = 0;
  for (let i = 0; i < numEqs; i++) {
    let r = -p[i];
    for (let j = 0; j < numUnknowns; j++) r += A[i][j] * solution[j];
    maxResidual = Math.max(maxResidual, Math.abs(r));
  }

  return {
    forces,
    reactions: reactionVecs,
    status: maxResidual < 0.1 ? 'determinate' : 'unstable',
    residual: maxResidual,
  };
}
