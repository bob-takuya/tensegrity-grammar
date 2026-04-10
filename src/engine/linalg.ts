/**
 * Simple linear algebra utilities.
 * Gaussian elimination with partial pivoting for solving Ax = b.
 */

/** Solve Ax = b using Gaussian elimination with partial pivoting.
 *  A is m×n, b is m×1. Returns x (n×1) or null if no unique solution.
 *  For over-determined systems (m > n), uses least-squares via normal equations.
 */
export function solve(A: number[][], b: number[]): number[] | null {
  const m = A.length;
  if (m === 0) return null;
  const n = A[0].length;

  if (m > n) {
    // Over-determined: solve A^T A x = A^T b
    return solveNormalEquations(A, b);
  }

  if (m < n) {
    // Under-determined: no unique solution
    return null;
  }

  // Square system: Gaussian elimination
  return gaussianElimination(A, b);
}

function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  // Augmented matrix
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }

    if (maxVal < 1e-10) return null; // Singular

    // Swap rows
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(aug[i][i]) < 1e-10) return null;
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= aug[i][j] * x[j];
    }
    x[i] /= aug[i][i];
  }

  return x;
}

function solveNormalEquations(A: number[][], b: number[]): number[] | null {
  const m = A.length;
  const n = A[0].length;

  // AtA = A^T * A (n×n)
  const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < m; k++) {
        sum += A[k][i] * A[k][j];
      }
      AtA[i][j] = sum;
    }
  }

  // Atb = A^T * b (n×1)
  const Atb = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      Atb[i] += A[k][i] * b[k];
    }
  }

  return gaussianElimination(AtA, Atb);
}
