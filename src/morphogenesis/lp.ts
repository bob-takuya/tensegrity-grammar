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
 * drives f to zero. The critical subtlety: at α = 0 the gradient is
 * ∇f(0) = 2ε · (Σ_cable W_e − Σ_strut W_e), whose magnitude is O(ε).
 * With ε = 1e-6 a single descent step moves only ~1e-6 in α, so the
 * updated Wα is still well inside the ε margin and the loss barely
 * budges. Plain gradient descent therefore gets pinned at the trivial
 * minimum f(0) = |E|·ε² ≈ 1e-11, which is NOT a feasible solution
 * (it just has every component of Wα at zero). To escape this trap
 * we prime the multi-start with the LEAST-SQUARES solution to
 * Wα = b, where b_e = −target for struts and +target for cables.
 * That point sits in the interior of the feasible polyhedron
 * whenever one exists, and descent only needs to polish the
 * boundary.
 */

import { solve } from './linalg';

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

  // Zero-row members are auto-satisfied mechanisms: their force
  // density is identically 0 in every self-stress, so the LP can
  // neither push them negative (for a strut) nor positive (for a
  // cable). Including them would pin the hinge loss at #zero·ε²
  // and make every call return "infeasible" even when the
  // *non-degenerate* constraints are perfectly solvable. Drop them
  // here; the caller can reclassify them as 'candidate' after the
  // LP settles.
  const rowIsZero = (row: number[]): boolean => {
    let s = 0;
    for (let j = 0; j < k; j++) s += row[j] * row[j];
    return s < 1e-18;
  };
  const resolveRow = (id: number): number | null => {
    const r = memberIdx.get(id);
    if (r === undefined) return null;
    if (rowIsZero(W[r])) return null;
    return r;
  };
  const strutRows = strutIds.map(resolveRow).filter((r): r is number => r !== null);
  const cableRows = cableIds.map(resolveRow).filter((r): r is number => r !== null);

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

  // Multi-start: identity columns, random, all-ones, and most
  // importantly an analytical least-squares seed. The descent below
  // can only polish a near-feasible point; without an informed seed
  // it gets pinned at the ε²-scale minimum of f(0).
  const starts: number[][] = [];

  // 1) Least-squares seed — the star attraction. We ask for
  //       Wα = b      with b_e = -target (strut) or +target (cable),
  //    and solve via the normal equations (handled by `solve`).
  //    Target is chosen an order of magnitude larger than ε so the
  //    LS solution lives comfortably inside the polytope whenever
  //    one exists; even if it doesn't, it's a much better basin
  //    than the origin for hinge-loss descent.
  const target = Math.max(10 * eps, 0.1);
  {
    const b = new Array(E).fill(0);
    for (const e of strutRows) b[e] = -target;
    for (const e of cableRows) b[e] = +target;
    const ls = solve(W, b);
    if (ls && ls.every(v => Number.isFinite(v))) {
      starts.push(ls);
    }
  }

  // 2) Axis-aligned probes.
  for (let j = 0; j < Math.min(k, 5); j++) {
    const s = new Array(k).fill(0);
    s[j] = 1;
    starts.push(s);
  }

  // 3) Signed-indicator seed α₀ = W^T b (direction of steepest
  //    descent at 0). Scaled up so that |α₀| is O(1) instead of
  //    O(1/||W||) — this matters because the gradient at α = 0 is
  //    O(ε), so without scaling the first step is invisible to the
  //    line search.
  {
    const s = new Array(k).fill(0);
    for (const e of strutRows) {
      for (let j = 0; j < k; j++) s[j] -= W[e][j];
    }
    for (const e of cableRows) {
      for (let j = 0; j < k; j++) s[j] += W[e][j];
    }
    let norm = 0;
    for (const v of s) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      for (let j = 0; j < k; j++) s[j] /= norm;
    }
    starts.push(s);
    starts.push(s.map(x => -x));
  }

  // 4) Random and all-ones as last-ditch fallbacks.
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
