/**
 * Tiny LP feasibility solver for Class-1 enforcement.
 *
 * We never need a full simplex implementation — Sub.D of the search
 * algorithm only asks one question:
 *
 *     "Does there exist α ∈ ℝ^k such that
 *         (W α)_e ≤ -ε  for e ∈ M        (struts)
 *         (W α)_e ≥ +ε  for e ∈ E \ M    (cables)
 *      ?"
 *
 * The feasible set is a polyhedron. If it is non-empty, gradient
 * descent on the squared hinge-loss
 *
 *     f(α) = Σ_{strut e}  max(0, ε + (W α)_e)²
 *          + Σ_{cable e}  max(0, ε - (W α)_e)²
 *
 * drives f to zero. Because f is convex and piecewise-quadratic, the
 * descent is well-behaved and a line search converges in ~O(k²) steps
 * for the small problem sizes this app produces (k ≤ 40, |E| ≤ 200).
 *
 * The same loss doubles as an "infeasibility score" — callers use it
 * to rank conflicts when the primary LP check fails.
 */

export interface LPCheckResult {
  feasible: boolean;
  alpha: number[];
  residual: number;     // final loss value; 0 ⇔ feasible
}

/**
 * Solve the Class-1 LP feasibility problem by minimising the squared
 * hinge loss above with projected gradient descent.
 *
 * @param W           |E| × k dense basis matrix (rows = members)
 * @param memberIdx   Map member_id → row index in W
 * @param strutIds    member_ids that should become struts ((Wα)_e ≤ -ε)
 * @param cableIds    member_ids that should become cables ((Wα)_e ≥ +ε)
 * @param eps         sign margin
 */
export function lpClass1Check(
  W: number[][],
  memberIdx: Map<number, number>,
  strutIds: number[],
  cableIds: number[],
  eps: number = 1e-6,
): LPCheckResult {
  const E = W.length;
  if (E === 0) return { feasible: false, alpha: [], residual: Infinity };
  const k = W[0].length;
  if (k === 0) return { feasible: false, alpha: [], residual: Infinity };

  const strutRows = strutIds.map(id => memberIdx.get(id)).filter(i => i !== undefined) as number[];
  const cableRows = cableIds.map(id => memberIdx.get(id)).filter(i => i !== undefined) as number[];

  // Compute (Wα)_e for all e
  const evalWalpha = (alpha: number[]): number[] => {
    const out = new Array(E).fill(0);
    for (let e = 0; e < E; e++) {
      let s = 0;
      for (let j = 0; j < k; j++) s += W[e][j] * alpha[j];
      out[e] = s;
    }
    return out;
  };

  // Loss and its gradient wrt α.
  //   f = Σ_strut max(0, ε + w_e)²  +  Σ_cable max(0, ε - w_e)²
  //   ∂f/∂α_j = Σ_strut 2·max(0, ε + w_e)·W[e,j]
  //           + Σ_cable -2·max(0, ε - w_e)·W[e,j]
  const lossAndGrad = (alpha: number[]): { f: number; g: number[] } => {
    const w = evalWalpha(alpha);
    let f = 0;
    const g = new Array(k).fill(0);
    for (const e of strutRows) {
      const v = eps + w[e];
      if (v > 0) {
        f += v * v;
        for (let j = 0; j < k; j++) g[j] += 2 * v * W[e][j];
      }
    }
    for (const e of cableRows) {
      const v = eps - w[e];
      if (v > 0) {
        f += v * v;
        for (let j = 0; j < k; j++) g[j] -= 2 * v * W[e][j];
      }
    }
    return { f, g };
  };

  // Multi-start: try a few initial directions so we don't get stuck
  // on the zero α. Besides identity columns and random directions we
  // also include a signed-indicator seed α₀ = W^T b where b_e = -1
  // for struts and +1 for cables. This is the direction of steepest
  // decrease of the hinge loss at α = 0, which in well-conditioned
  // cases already lands inside the feasible polyhedron after a single
  // normalisation — and for the degenerate cases it still gives the
  // descent a vastly better starting basin than plain zero.
  const starts: number[][] = [];
  for (let j = 0; j < Math.min(k, 5); j++) {
    const s = new Array(k).fill(0);
    s[j] = 1;
    starts.push(s);
  }
  // Signed-indicator seed α₀ = W^T b.
  {
    const s = new Array(k).fill(0);
    for (const e of strutRows) {
      for (let j = 0; j < k; j++) s[j] -= W[e][j];
    }
    for (const e of cableRows) {
      for (let j = 0; j < k; j++) s[j] += W[e][j];
    }
    starts.push(s);
    // And its negation, in case we got the sign convention flipped.
    starts.push(s.map(x => -x));
  }
  starts.push(new Array(k).fill(0).map(() => Math.random() * 2 - 1));
  starts.push(new Array(k).fill(1));

  let best: number[] = starts[0];
  let bestF = Infinity;

  for (const seed of starts) {
    let alpha = [...seed];
    for (let iter = 0; iter < 400; iter++) {
      const { f, g } = lossAndGrad(alpha);
      if (f < 1e-14) { alpha = [...alpha]; break; }
      const gl = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
      if (gl < 1e-14) break;
      // Back-tracking line search
      let step = 1.0;
      let improved = false;
      for (let ls = 0; ls < 20; ls++) {
        const trial = alpha.map((a, i) => a - step * g[i]);
        const ft = lossAndGrad(trial).f;
        if (ft < f - 1e-10 * step * gl * gl * 0.1) {
          alpha = trial;
          improved = true;
          break;
        }
        step *= 0.5;
      }
      if (!improved) break;
    }
    const finalLoss = lossAndGrad(alpha).f;
    if (finalLoss < bestF) {
      bestF = finalLoss;
      best = alpha;
    }
  }

  // Normalise α so the largest |(Wα)| lands at 1 — keeps the chosen
  // force densities in a consistent scale for visualisation.
  const w = evalWalpha(best);
  let maxAbs = 0;
  for (const v of w) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  if (maxAbs > 1e-12) {
    for (let j = 0; j < k; j++) best[j] /= maxAbs;
  }

  // Per-constraint feasibility check. The hinge-loss threshold alone
  // is insufficient: the degenerate minimum α = 0 has a loss of
  // |E|·ε², which for ε=1e-6 is ~1e-11 and sails under any reasonable
  // absolute threshold — yet it corresponds to a structure where
  // every member has force density zero, which is certainly NOT a
  // Class-1 solution. We therefore re-evaluate each constraint on the
  // *normalised* α and require a positive margin.
  //
  // After normalisation we expect max|Wα| = 1, so we demand that
  // strut rows hit ≤ -(ε/2) and cable rows hit ≥ +(ε/2). A solution
  // whose α was scaled by maxAbs≈0 will have all |(Wα)_e| ≈ ε/maxAbs,
  // which fails this check unless maxAbs itself was ≥ ε.
  const wNorm = evalWalpha(best);
  let hardFeasible = true;
  const margin = eps * 0.5;
  for (const e of strutRows) {
    if (!(wNorm[e] <= -margin)) { hardFeasible = false; break; }
  }
  if (hardFeasible) {
    for (const e of cableRows) {
      if (!(wNorm[e] >= +margin)) { hardFeasible = false; break; }
    }
  }

  return {
    feasible: hardFeasible,
    alpha: best,
    residual: bestF,
  };
}

/**
 * Cheap 2-edge feasibility check used by FIND_CONFLICTS. Asks whether a
 * single pair of rows of W can simultaneously hit (-1, +1). The answer
 * is yes iff the 2×k submatrix has rank 2, so we just test the Gram
 * determinant.
 */
export function lpPairCheck(
  W: number[][],
  rowStrut: number,
  rowCable: number,
  eps: number = 1e-8,
): boolean {
  const k = W[0].length;
  let bb = 0, aa = 0, ab = 0;
  for (let j = 0; j < k; j++) {
    const a = W[rowStrut][j];
    const b = W[rowCable][j];
    aa += a * a;
    bb += b * b;
    ab += a * b;
  }
  const det = aa * bb - ab * ab;
  return det > eps;
}
