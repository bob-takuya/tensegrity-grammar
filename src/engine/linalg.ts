/**
 * Linear algebra utilities.
 * Supports square, over-determined, and under-determined systems.
 */

/**
 * Solve Ax = b.
 *  - Square (m = n): Gaussian elimination
 *  - Over-determined (m > n): least-squares via A^T A x = A^T b
 *  - Under-determined (m < n): minimum-norm via x = A^T (A A^T)^{-1} b
 */
export function solve(A: number[][], b: number[]): number[] | null {
  const m = A.length;
  if (m === 0) return null;
  const n = A[0].length;

  if (m > n) {
    return solveLeastSquares(A, b);
  }
  if (m < n) {
    return solveMinNorm(A, b);
  }
  return gaussianElimination(A, b);
}

/**
 * Gaussian elimination with partial pivoting for square systems.
 */
function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-10) return null;
    if (maxRow !== col) [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(aug[i][i]) < 1e-10) return null;
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i];
  }
  return x;
}

/** Over-determined: least-squares via normal equations A^T A x = A^T b */
function solveLeastSquares(A: number[][], b: number[]): number[] | null {
  const m = A.length, n = A[0].length;
  const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0; for (let k = 0; k < m; k++) s += A[k][i] * A[k][j];
      AtA[i][j] = s;
    }
    for (let k = 0; k < m; k++) Atb[i] += A[k][i] * b[k];
  }
  return gaussianElimination(AtA, Atb);
}

/**
 * Under-determined: minimum-norm solution x = A^T (A A^T)^{-1} b.
 * This gives the solution with smallest ||x||, which for tensegrity
 * means the force distribution closest to zero (no prestress bias).
 */
function solveMinNorm(A: number[][], b: number[]): number[] | null {
  const m = A.length, n = A[0].length;

  // Compute AAt = A × A^T (m × m)
  const AAt: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0; for (let k = 0; k < n; k++) s += A[i][k] * A[j][k];
      AAt[i][j] = s;
    }
  }

  // Solve AAt × y = b  for y
  const y = gaussianElimination(AAt, b);
  if (!y) return null;

  // x = A^T × y
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) x[i] += A[k][i] * y[k];
  }
  return x;
}

/**
 * Find ALL nullspace basis vectors of A (m × n, m < n).
 * Returns vectors v[] such that A × v ≈ 0.
 */
export function findNullspaceBasis(A: number[][]): number[][] {
  const m = A.length, n = A[0].length;

  // Build augmented matrix (no RHS, just find rank and pivots)
  const M: number[][] = A.map(row => [...row]);

  const pivotCols: number[] = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    // Find pivot in this column
    let maxVal = Math.abs(M[row][col]);
    let maxRow = row;
    for (let r = row + 1; r < m; r++) {
      if (Math.abs(M[r][col]) > maxVal) { maxVal = Math.abs(M[r][col]); maxRow = r; }
    }
    if (maxVal < 1e-10) continue; // skip this column (free variable)

    // Swap
    if (maxRow !== row) [M[row], M[maxRow]] = [M[maxRow], M[row]];

    // Eliminate below
    for (let r = row + 1; r < m; r++) {
      const factor = M[r][col] / M[row][col];
      for (let j = col; j < n; j++) M[r][j] -= factor * M[row][j];
    }
    // Eliminate above
    for (let r = 0; r < row; r++) {
      const factor = M[r][col] / M[row][col];
      for (let j = col; j < n; j++) M[r][j] -= factor * M[row][j];
    }

    pivotCols.push(col);
    row++;
  }

  const rank = pivotCols.length;
  if (rank >= n) return []; // full rank, no nullspace

  // Find ALL free columns
  const pivotSet = new Set(pivotCols);
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) {
    if (!pivotSet.has(c)) freeCols.push(c);
  }
  if (freeCols.length === 0) return [];

  // For each free column, construct a nullspace basis vector
  const basis: number[][] = [];
  for (const freeCol of freeCols) {
    const v = new Array(n).fill(0);
    v[freeCol] = 1;

    for (let i = rank - 1; i >= 0; i--) {
      const pc = pivotCols[i];
      let s = 0;
      for (let j = 0; j < n; j++) {
        if (j !== pc) s += M[i][j] * v[j];
      }
      v[pc] = -s / M[i][pc];
    }
    basis.push(v);
  }

  return basis;
}
