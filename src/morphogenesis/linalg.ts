/**
 * Minimal linear algebra for the cellular morphogenesis engine.
 *
 * The spec (F2.3 / F2.4) requires two primitives:
 *   - buildA(nodes, members) — equilibrium matrix A
 *   - nullspace(A, tol)      — basis of ker A (self-stress space W)
 *
 * Both are implemented with a small dense-matrix RREF and are exact
 * enough for the K₅-scale problems the algorithm manipulates.
 */

import { NodeRow, MemberRow } from './types';

// ─── Gaussian elimination primitives ─────────────────────────────

/** Gaussian elimination with partial pivoting on a square system. */
function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(aug[col][col]), maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > maxVal) { maxVal = Math.abs(aug[r][col]); maxRow = r; }
    }
    if (maxVal < 1e-12) return null;
    if (maxRow !== col) [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    for (let r = col + 1; r < n; r++) {
      const f = aug[r][col] / aug[col][col];
      for (let j = col; j <= n; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(aug[i][i]) < 1e-12) return null;
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i];
  }
  return x;
}

/** Solve A x = b for any shape. Square → direct; tall → LS; wide → min-norm. */
export function solve(A: number[][], b: number[]): number[] | null {
  const m = A.length, n = A[0].length;
  if (m === n) return gaussianElimination(A, b);
  if (m > n) {
    const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const Atb = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += A[k][i] * A[k][j];
        AtA[i][j] = s;
      }
      for (let k = 0; k < m; k++) Atb[i] += A[k][i] * b[k];
    }
    return gaussianElimination(AtA, Atb);
  }
  const AAt: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i][k] * A[j][k];
      AAt[i][j] = s;
    }
  }
  const y = gaussianElimination(AAt, b);
  if (!y) return null;
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let k = 0; k < m; k++) x[i] += A[k][i] * y[k];
  return x;
}

// ─── F2.3 — build_A(nodes, members) ──────────────────────────────

/**
 * Build the equilibrium matrix A of size (3 |V|) × |E|.
 *
 *   A_{3i+d, e} = (p_i - p_j)_d / ||p_i - p_j||    (node i)
 *                  and the negation at node j
 *
 * The columns of A span the space of resolvable member forces; the
 * self-stress space is W = ker A.
 *
 * @returns { A, nodeIndex }
 *   nodeIndex maps node_id → row block index i so callers can index into A.
 */
export function buildEquilibriumMatrix(
  nodes: NodeRow[],
  members: MemberRow[],
): { A: number[][]; nodeIndex: Map<number, number>; lengths: number[] } {
  const n = nodes.length;
  const m = members.length;
  const nodeIndex = new Map<number, number>();
  nodes.forEach((nd, i) => nodeIndex.set(nd.node_id, i));

  const A: number[][] = Array.from({ length: 3 * n }, () => new Array(m).fill(0));
  const lengths = new Array(m).fill(1);

  for (let e = 0; e < m; e++) {
    const mem = members[e];
    const i = nodeIndex.get(mem.node_a);
    const j = nodeIndex.get(mem.node_b);
    if (i === undefined || j === undefined) continue;
    const pi = nodes[i], pj = nodes[j];
    const dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) continue;
    lengths[e] = len;
    A[3 * i + 0][e] =  dx / len; A[3 * i + 1][e] =  dy / len; A[3 * i + 2][e] =  dz / len;
    A[3 * j + 0][e] = -dx / len; A[3 * j + 1][e] = -dy / len; A[3 * j + 2][e] = -dz / len;
  }
  return { A, nodeIndex, lengths };
}

// ─── F2.4 — nullspace(A, tol) ────────────────────────────────────

/**
 * Basis of the null space of A, via RREF with relative pivot tolerance.
 * Returns a list of basis vectors (length = number of columns of A).
 */
export function nullspace(A: number[][], tol?: number): number[][] {
  if (A.length === 0 || A[0].length === 0) return [];
  const m = A.length, n = A[0].length;
  const M: number[][] = A.map(row => [...row]);

  let absMax = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    const v = Math.abs(A[i][j]);
    if (v > absMax) absMax = v;
  }
  const pivotTol = tol ?? Math.max(1e-12, absMax * 1e-9);

  const pivotCols: number[] = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let maxVal = 0, maxRow = row;
    for (let r = row; r < m; r++) {
      if (Math.abs(M[r][col]) > maxVal) { maxVal = Math.abs(M[r][col]); maxRow = r; }
    }
    if (maxVal < pivotTol) continue;
    [M[row], M[maxRow]] = [M[maxRow], M[row]];
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const f = M[r][col] / M[row][col];
      for (let j = col; j < n; j++) M[r][j] -= f * M[row][j];
    }
    pivotCols.push(col);
    row++;
  }
  const rank = pivotCols.length;
  if (rank >= n) return [];
  const pivotSet = new Set(pivotCols);
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) if (!pivotSet.has(c)) freeCols.push(c);

  const basis: number[][] = [];
  for (const fc of freeCols) {
    const v = new Array(n).fill(0);
    v[fc] = 1;
    for (let i = rank - 1; i >= 0; i--) {
      const pc = pivotCols[i];
      let s = 0;
      for (let j = 0; j < n; j++) if (j !== pc) s += M[i][j] * v[j];
      v[pc] = -s / M[i][pc];
    }
    basis.push(v);
  }
  return basis;
}

/** Legacy alias used by older call-sites. */
export const findNullspaceBasis = nullspace;
