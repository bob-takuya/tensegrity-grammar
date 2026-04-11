/**
 * Minimal linear algebra for K₅ morphogenesis engine.
 */

/** Gaussian elimination with partial pivoting for square systems. */
function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(aug[col][col]), maxRow = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > maxVal) { maxVal = Math.abs(aug[r][col]); maxRow = r; }
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

export function solve(A: number[][], b: number[]): number[] | null {
  const m = A.length, n = A[0].length;
  if (m === n) return gaussianElimination(A, b);
  if (m > n) {
    // Least squares
    const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const Atb = new Array(n).fill(0);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < m; k++) s += A[k][i] * A[k][j]; AtA[i][j] = s; } for (let k = 0; k < m; k++) Atb[i] += A[k][i] * b[k]; }
    return gaussianElimination(AtA, Atb);
  }
  // Under-determined: min-norm
  const AAt: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) { let s = 0; for (let k = 0; k < n; k++) s += A[i][k] * A[j][k]; AAt[i][j] = s; }
  const y = gaussianElimination(AAt, b);
  if (!y) return null;
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let k = 0; k < m; k++) x[i] += A[k][i] * y[k];
  return x;
}

/**
 * Find all nullspace basis vectors of A (any shape).
 */
export function findNullspaceBasis(A: number[][]): number[][] {
  const m = A.length, n = A[0].length;
  const M: number[][] = A.map(row => [...row]);
  const pivotCols: number[] = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let maxVal = 0, maxRow = row;
    for (let r = row; r < m; r++) if (Math.abs(M[r][col]) > maxVal) { maxVal = Math.abs(M[r][col]); maxRow = r; }
    if (maxVal < 1e-10) continue;
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
