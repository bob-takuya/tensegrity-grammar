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

  // Per-constraint feasibility check on the RAW (un-normalised) α.
  //
  // We used to divide α by max|Wα| for "consistent visualisation
  // scale", but that normalisation compressed the smallest
  // satisfying values (ε/max|Wα|) below applyAlpha's SIGN_EPS
  // whenever max|Wα| grew beyond ~100, causing valid struts and
  // cables to be mis-classified as 'candidate' (the Triplex
  // regression). We keep α at its natural scale here — the hard
  // feasibility check already handles scale via `eps`, and
  // applyAlpha uses |Wα| ≥ ε = 1e-6 to decide types, which is
  // comfortable above its 1e-8 epsilon regardless of problem size.
  const wRaw = evalWalpha(best);
  let hardFeasible = true;
  const margin = eps * 0.5;
  for (const e of strutRows) {
    if (!(wRaw[e] <= -margin)) { hardFeasible = false; break; }
  }
  if (hardFeasible) {
    for (const e of cableRows) {
      if (!(wRaw[e] >= +margin)) { hardFeasible = false; break; }
    }
  }

  return {
    feasible: hardFeasible,
    alpha: best,
    residual: bestF,
  };
}

// ─── Strut-only LP (K_n null space approach) ──────────────

/**
 * Strut-only LP feasibility check used by the K_n null space
 * algorithm.
 *
 *   "Does there exist α ∈ ℝ^k such that
 *        (W α)_e ≤ -ε   for every e ∈ M
 *    ?"
 *
 * Crucially, there are NO cable constraints: cables are whichever
 * non-matching edges end up with (Wα)_e > +ε after the fact, and
 * zero-force edges (|(Wα)_e| ≤ ε) are removed from the structure.
 * This is the key asymmetry of the K_n approach — when W is the
 * full null space of the complete graph, every known tensegrity
 * (Triplex, n-prism, icosahedron, Snelson tower) has a feasible
 * strut-only LP, and the cables/zero-force partition falls out
 * from sign(Wα) with no additional constraints.
 *
 * The solver uses the same squared-hinge loss minimiser as the
 * dual-sided `lpClass1Check` but with a gradient-aligned seed
 * strategy tailored to the strut-only case. Since there is no
 * cable penalty, α = 0 still has a non-zero loss (|M|·ε²) but
 * the gradient at the origin is exactly −W_M^T·1, which points
 * straight into the feasible region whenever one exists — so
 * the descent rarely gets trapped.
 *
 * @param W          |E| × k dense K_n null space basis
 * @param memberIdx  member_id → row index in W
 * @param strutIds   member_ids that must be compressive (Wα ≤ -ε)
 * @param eps        sign margin (default 1e-6)
 * @param maxIters   per-seed descent cap (default 2000)
 */
export function lpStrutOnly(
  W: number[][],
  memberIdx: Map<number, number>,
  strutIds: number[],
  eps: number = 1e-6,
  maxIters: number = 2000,
): LPCheckResult {
  const E = W.length;
  if (E === 0) return { feasible: false, alpha: [], residual: Infinity };
  const k = W[0].length;
  if (k === 0) return { feasible: false, alpha: [], residual: Infinity };

  // Drop zero-row members (force density identically 0 in every
  // basis direction) — they can never be struts no matter what α
  // we pick. Keeping them would pin the hinge loss at #zero·ε².
  const rowIsZero = (row: number[]): boolean => {
    let s = 0;
    for (let j = 0; j < k; j++) s += row[j] * row[j];
    return s < 1e-18;
  };
  const strutRows: number[] = [];
  for (const id of strutIds) {
    const r = memberIdx.get(id);
    if (r === undefined) continue;
    if (rowIsZero(W[r])) continue;
    strutRows.push(r);
  }
  // Canonicalise the strut row list so callers that pass the
  // same member IDs in different orders get bit-identical α.
  strutRows.sort((a, b) => a - b);

  if (strutRows.length === 0) {
    return { feasible: false, alpha: new Array(k).fill(0), residual: Infinity };
  }

  // Squared-hinge loss with strut-only penalties.
  //   f(α) = Σ_{e∈M} max(0, ε + (Wα)_e)²
  //   ∂f/∂α_j = Σ_{e∈M} 2 · max(0, ε + (Wα)_e) · W[e,j]
  const lossAndGrad = (alpha: number[]): { f: number; g: number[] } => {
    let f = 0;
    const g = new Array(k).fill(0);
    for (const e of strutRows) {
      let wa = 0;
      for (let j = 0; j < k; j++) wa += W[e][j] * alpha[j];
      const v = eps + wa;
      if (v > 0) {
        f += v * v;
        for (let j = 0; j < k; j++) g[j] += 2 * v * W[e][j];
      }
    }
    return { f, g };
  };

  // ── Seeds ────────────────────────────────────────────────
  const seeds: number[][] = [];

  // (1) Gradient seed: α₀ = −Σ_{e∈M} W[e,:]. This is the direction
  //     of steepest descent at the origin (scaled), and for every
  //     known tensegrity it already lands inside or extremely close
  //     to the feasible region. We add both the normalised and the
  //     scaled-up (magnitude 1) versions so line search can pick
  //     whichever steps the cleanest.
  {
    const s = new Array(k).fill(0);
    for (const e of strutRows) {
      for (let j = 0; j < k; j++) s[j] -= W[e][j];
    }
    let norm = 0;
    for (const v of s) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 1e-14) {
      seeds.push(s.map((v) => v / norm));
      seeds.push(s.map((v) => -v / norm));
      // Also a scaled-up variant so the first gradient step exits
      // the ε-sized basin in one line-search move.
      seeds.push(s.map((v) => v / norm * 10));
    }
  }

  // (2) Least-squares seeds. We use TWO variants:
  //
  //   (2a) b_e = −target on strut rows, 0 elsewhere. Minimum-
  //        norm α that compresses the matching; good for very
  //        sparse self-stresses.
  //
  //   (2b) b_e = −target on strut rows, +target on every non-
  //        strut row. This asks the LP for an α that compresses
  //        the matching AND stretches everything else, even
  //        edges that "should" be zero-force. The LS solution
  //        projects this over-constrained target onto the
  //        nearest feasible α, which tends to have FULL SUPPORT
  //        across the null space basis. For symmetric
  //        structures like n-prisms and the icosahedron, this
  //        is the seed that lands in the canonical self-stress
  //        basin — the minimum-norm LS only finds sub-
  //        tensegrities because it's allowed to zero out most
  //        of K_n.
  {
    const target = Math.max(10 * eps, 0.1);
    const strutRowSet = new Set(strutRows);
    const b1 = new Array(E).fill(0);
    const b2 = new Array(E).fill(0);
    for (let e = 0; e < E; e++) {
      if (strutRowSet.has(e)) {
        b1[e] = -target;
        b2[e] = -target;
      } else {
        b2[e] = +target;
      }
    }
    const ls1 = solve(W, b1);
    if (ls1 && ls1.every((v) => Number.isFinite(v))) seeds.push(ls1);
    const ls2 = solve(W, b2);
    if (ls2 && ls2.every((v) => Number.isFinite(v))) seeds.push(ls2);
  }

  // (3) Axis-aligned probes ±e_j for the first few coordinates.
  for (let j = 0; j < Math.min(k, 6); j++) {
    const s = new Array(k).fill(0);
    s[j] = 1;
    seeds.push(s);
    const s2 = new Array(k).fill(0);
    s2[j] = -1;
    seeds.push(s2);
  }

  // (4) All-ones / all-negative-ones. These cover the "every
  //     basis column contributes equally" direction, which for
  //     symmetric structures (n-prisms, icosahedron) tends to
  //     produce the canonical full-support self-stress instead
  //     of a minimum-norm sub-tensegrity.
  seeds.push(new Array(k).fill(1));
  seeds.push(new Array(k).fill(-1));
  // Also a large-magnitude variant so the first line-search move
  // reaches deep into the feasible polytope.
  seeds.push(new Array(k).fill(10));
  seeds.push(new Array(k).fill(-10));

  // (5) Deterministic pseudo-random uniform seeds (mulberry32
  //     with a hash of the strut rows so each LP call has a
  //     reproducible but unique sequence). Math.random() was
  //     making the algorithm non-deterministic — identical
  //     inputs gave different α across runs because the LP's
  //     multi-start explored different basins.
  {
    let hashSeed = 0x12345678;
    for (const e of strutRows) hashSeed = (hashSeed * 31 + e) | 0;
    let rs = hashSeed >>> 0;
    const rng = () => {
      rs += 0x6d2b79f5;
      let t = rs;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let r = 0; r < 8; r++) {
      const s = new Array(k).fill(0).map(() => rng() * 2 - 1);
      let norm = 0;
      for (const v of s) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 1e-14) {
        for (let j = 0; j < k; j++) s[j] /= norm;
      }
      seeds.push(s);
    }
  }

  // ── Descent ──────────────────────────────────────────────
  let best = seeds[0] ? [...seeds[0]] : new Array(k).fill(0);
  let bestF = Infinity;

  for (const seed of seeds) {
    let alpha = [...seed];
    let prevF = Infinity;
    for (let iter = 0; iter < maxIters; iter++) {
      const { f, g } = lossAndGrad(alpha);
      if (f < 1e-14) { prevF = f; break; }
      const gl = Math.sqrt(g.reduce((s, v) => s + v * v, 0));
      if (gl < 1e-14) { prevF = f; break; }
      // Back-tracking line search with Armijo-like acceptance.
      let step = 1.0;
      let improved = false;
      for (let ls = 0; ls < 25; ls++) {
        const trial = alpha.map((a, i) => a - step * g[i]);
        const ft = lossAndGrad(trial).f;
        if (ft < f - 1e-10) {
          alpha = trial;
          prevF = ft;
          improved = true;
          break;
        }
        step *= 0.5;
      }
      if (!improved) { prevF = f; break; }
    }
    const finalF = prevF < Infinity ? prevF : lossAndGrad(alpha).f;
    if (finalF < bestF) {
      bestF = finalF;
      best = alpha;
    }
    if (bestF < 1e-14) break;
  }

  // ── Hard feasibility check ───────────────────────────────
  const margin = eps * 0.5;
  let feasible = true;
  for (const e of strutRows) {
    let wa = 0;
    for (let j = 0; j < k; j++) wa += W[e][j] * best[j];
    if (!(wa <= -margin)) { feasible = false; break; }
  }

  return { feasible, alpha: best, residual: bestF };
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

// ─── Async LP check (chunked, for UI responsiveness) ──────

/**
 * Async counterpart to `lpClass1Check` that yields control back
 * to the event loop every `chunkSize` gradient-descent
 * iterations. Used by the search driver so the 3D viewer can
 * actually repaint while a long LP solve is in progress — a
 * synchronous 400-iter × 8-seed × k-dim LP on n = 20 can
 * otherwise lock up the main thread for hundreds of
 * milliseconds per Phase 3 iteration.
 *
 * The `yieldFn` argument should return `true` when the caller
 * wants us to stop early (e.g. wall-clock deadline reached or
 * AbortController aborted). When that happens we return the
 * best-so-far α and residual — the caller must tolerate a
 * partial answer.
 *
 * Semantics are otherwise identical to `lpClass1Check`:
 * multi-start, analytical LS seed, signed-indicator seed,
 * back-tracking line search, hard feasibility check on the raw
 * Wα with ε/2 margin.
 */
export async function lpClass1CheckAsync(
  W: number[][],
  memberIdx: Map<number, number>,
  strutIds: number[],
  cableIds: number[],
  yieldFn: () => Promise<boolean>,
  eps: number = 1e-6,
  // Raised 100 → 200: the per-start descent does ≤ 400 iterations
  // and a chunkSize of 200 means at most two yields per start
  // instead of four, halving the rAF overhead on the LP hot path
  // while still keeping yields frequent enough that the viewer
  // repaints during a long LP call.
  chunkSize: number = 200,
): Promise<LPCheckResult> {
  const E = W.length;
  if (E === 0) return { feasible: false, alpha: [], residual: Infinity };
  const k = W[0].length;
  if (k === 0) return { feasible: false, alpha: [], residual: Infinity };

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

  const evalWalpha = (alpha: number[]): number[] => {
    const out = new Array(E).fill(0);
    for (let e = 0; e < E; e++) {
      let s = 0;
      for (let j = 0; j < k; j++) s += W[e][j] * alpha[j];
      out[e] = s;
    }
    return out;
  };

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

  // Multi-start (identical seeds to the sync version).
  const starts: number[][] = [];
  const target = Math.max(10 * eps, 0.1);
  {
    const b = new Array(E).fill(0);
    for (const e of strutRows) b[e] = -target;
    for (const e of cableRows) b[e] = +target;
    const ls = solve(W, b);
    if (ls && ls.every(v => Number.isFinite(v))) starts.push(ls);
  }
  for (let j = 0; j < Math.min(k, 5); j++) {
    const s = new Array(k).fill(0);
    s[j] = 1;
    starts.push(s);
  }
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
  starts.push(new Array(k).fill(0).map(() => Math.random() * 2 - 1));
  starts.push(new Array(k).fill(1));

  let best: number[] = starts[0];
  let bestF = Infinity;
  const MAX_ITERS = 400;

  // The degenerate α = 0 solution has hinge loss
  //     trivialLoss = (|strutRows| + |cableRows|) · ε²
  // (every constraint has slack = ε on its soft side). Any α that
  // is below `trivialLoss * 0.01` has escaped the degenerate basin
  // by at least 2 orders of magnitude and is almost certainly
  // feasible; we can short-circuit the remaining starts there.
  const trivialLoss = (strutRows.length + cableRows.length) * eps * eps;
  const escapedBasinThreshold = trivialLoss * 0.01;

  for (let si = 0; si < starts.length; si++) {
    let alpha = [...starts[si]];
    for (let iterBase = 0; iterBase < MAX_ITERS; iterBase += chunkSize) {
      // Yield to the event loop before every chunk. The caller
      // returns `true` here when the wall-clock deadline has
      // been reached; we commit the current α as the
      // best-so-far result and give up.
      if (await yieldFn()) {
        const finalLoss = lossAndGrad(alpha).f;
        if (finalLoss < bestF) { bestF = finalLoss; best = alpha; }
        // Jump to result assembly.
        si = starts.length;
        break;
      }

      const end = Math.min(iterBase + chunkSize, MAX_ITERS);
      let didImprove = true;
      for (let iter = iterBase; iter < end; iter++) {
        const { f, g } = lossAndGrad(alpha);
        if (f < 1e-14) { didImprove = false; break; }
        const gl = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
        if (gl < 1e-14) { didImprove = false; break; }
        let step = 1.0;
        let stepImproved = false;
        for (let ls = 0; ls < 20; ls++) {
          const trial = alpha.map((a, i) => a - step * g[i]);
          const ft = lossAndGrad(trial).f;
          if (ft < f - 1e-10 * step * gl * gl * 0.1) {
            alpha = trial;
            stepImproved = true;
            break;
          }
          step *= 0.5;
        }
        if (!stepImproved) { didImprove = false; break; }
      }
      if (!didImprove) break;
    }
    const finalLoss = lossAndGrad(alpha).f;
    if (finalLoss < bestF) { bestF = finalLoss; best = alpha; }
    // Early exit once we've found a clean zero of the hinge loss.
    if (bestF < 1e-14) break;
    // Early exit once we've escaped the degenerate α ≈ 0 basin by
    // two orders of magnitude. At that point the hard feasibility
    // check below will very likely pass and the remaining starts
    // are just burning rAF frames.
    if (bestF < escapedBasinThreshold) break;
  }

  // Per-constraint feasibility check on the raw (un-normalised) α.
  const wRaw = evalWalpha(best);
  let hardFeasible = true;
  const margin = eps * 0.5;
  for (const e of strutRows) {
    if (!(wRaw[e] <= -margin)) { hardFeasible = false; break; }
  }
  if (hardFeasible) {
    for (const e of cableRows) {
      if (!(wRaw[e] >= +margin)) { hardFeasible = false; break; }
    }
  }

  return {
    feasible: hardFeasible,
    alpha: best,
    residual: bestF,
  };
}
