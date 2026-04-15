/**
 * Maximum matching utilities for Class-1 enforcement.
 *
 * For generic n in Aloui-style tensegrity search we cannot rely on
 * a simple greedy: the n = 6 Triplex case proves it fails badly.
 * Greedy prioritised by Σ|W[e,j]| picks BC (∑ = 1.058) and DE
 * (∑ = 0.866) first, blocks the hexagon diagonals, and returns a
 * matching of size 2 when the true maximum is 3 — so the LP never
 * even gets handed the Triplex strut set {A-E, C-D, B-F}.
 *
 * `maximumMatching` therefore uses Edmonds' blossom algorithm: it
 * seeds the matching by a priority-aware greedy, then repeatedly
 * finds augmenting paths via BFS with blossom contraction until no
 * augmenting path exists. For |V| ≤ 50 (the largest n this app
 * produces) the whole thing runs in sub-millisecond time.
 *
 * The priority argument still matters — it breaks ties between
 * otherwise-equivalent maximum matchings, letting the LP see
 * high-|w| edges first.
 */

export type Edge = { id: number; node_a: number; node_b: number };

/** Is `edge` compatible with the current matching? (no shared node) */
function compatible(matching: Set<number>, edges: Edge[], edge: Edge): boolean {
  for (const mid of matching) {
    const m = edges.find(e => e.id === mid);
    if (!m) continue;
    if (m.node_a === edge.node_a || m.node_a === edge.node_b ||
        m.node_b === edge.node_a || m.node_b === edge.node_b) return false;
  }
  return true;
}

/**
 * Edmonds' blossom algorithm for maximum cardinality matching on
 * general (non-bipartite) graphs.
 *
 * Returns an array of edge ids forming a maximum matching. The
 * initial matching is seeded by a priority-sorted greedy pass and
 * then augmented until no free vertex can reach another free
 * vertex through alternating edges.
 *
 * Implementation notes — the classic Gabow presentation:
 *   - `match[v]`  = partner of v in the current matching, or −1
 *   - `p[v]`      = parent of v in the alternating-path BFS tree
 *   - `base[v]`   = base vertex of the blossom currently containing v
 *   - When the BFS finds an edge between two even-level vertices it
 *     contracts the blossom (walk both parent chains to their LCA
 *     and mark every vertex on the way as belonging to the same
 *     super-vertex).
 *   - When it reaches an unmatched even-level vertex, flip the
 *     alternating path to grow the matching by 1.
 *
 * Complexity: O(|V|³) — sub-millisecond at the sizes this engine
 * produces (|V| ≤ 60 after all adhesions).
 */
export function maximumMatching(
  edges: Edge[],
  priority?: (e: Edge) => number,
): number[] {
  if (edges.length === 0) return [];

  // ── 1. Collect vertices and adjacency. ──────────────────
  const vertexSet = new Set<number>();
  for (const e of edges) {
    vertexSet.add(e.node_a);
    vertexSet.add(e.node_b);
  }
  const vertices = [...vertexSet];
  const vIdx = new Map<number, number>();
  vertices.forEach((v, i) => vIdx.set(v, i));
  const n = vertices.length;

  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const ai = vIdx.get(e.node_a)!;
    const bi = vIdx.get(e.node_b)!;
    adjacency[ai].push(bi);
    adjacency[bi].push(ai);
  }

  // ── 2. Priority-seeded greedy. ──────────────────────────
  //
  // Compute each edge's priority ONCE up-front. The old code
  // evaluated `priority(a)` and `priority(b)` inside the sort
  // comparator — fine if the priority is a pure function, but
  // the search drivers pass stateful RNG-backed priorities
  // (`() => rng() * 2 - 1`) that advance their internal state
  // on every call. The sort would then get different values
  // for the same edge on every comparison, producing random
  // garbage orderings and making the whole algorithm non-
  // deterministic. Caching the priority eliminates the
  // discrepancy and makes matching generation reproducible.
  // We also use the edge.id (deterministic) as a tie-break
  // instead of Math.random() for the same reason.
  const match: number[] = new Array(n).fill(-1);
  const order = [...edges];
  if (priority) {
    const cached = new Map<number, number>();
    for (const e of edges) cached.set(e.id, priority(e));
    order.sort((a, b) => {
      const pa = cached.get(a.id) ?? 0;
      const pb = cached.get(b.id) ?? 0;
      if (pa !== pb) return pb - pa;
      return a.id - b.id;
    });
  }
  for (const e of order) {
    const ai = vIdx.get(e.node_a)!;
    const bi = vIdx.get(e.node_b)!;
    if (match[ai] === -1 && match[bi] === -1) {
      match[ai] = bi; match[bi] = ai;
    }
  }

  // ── 3. Blossom augmentation. ────────────────────────────
  const p: number[] = new Array(n).fill(-1);
  const base: number[] = new Array(n).fill(-1);
  const used: boolean[] = new Array(n).fill(false);
  const blossomMark: boolean[] = new Array(n).fill(false);

  const lca = (a: number, b: number): number => {
    const seen: boolean[] = new Array(n).fill(false);
    let x = a;
    while (true) {
      x = base[x];
      seen[x] = true;
      if (match[x] === -1) break;
      x = p[match[x]];
    }
    let y = b;
    while (true) {
      y = base[y];
      if (seen[y]) return y;
      y = p[match[y]];
    }
  };

  const markPath = (v: number, b: number, child: number) => {
    while (base[v] !== b) {
      blossomMark[base[v]] = true;
      blossomMark[base[match[v]]] = true;
      p[v] = child;
      child = match[v];
      v = p[match[v]];
    }
  };

  const augmentFrom = (root: number): boolean => {
    for (let i = 0; i < n; i++) {
      p[i] = -1;
      base[i] = i;
      used[i] = false;
    }
    used[root] = true;
    const queue: number[] = [root];
    while (queue.length > 0) {
      const v = queue.shift()!;
      for (const to of adjacency[v]) {
        if (base[v] === base[to] || match[v] === to) continue;
        if (to === root || (match[to] !== -1 && p[match[to]] !== -1)) {
          const curBase = lca(v, to);
          for (let i = 0; i < n; i++) blossomMark[i] = false;
          markPath(v, curBase, to);
          markPath(to, curBase, v);
          for (let i = 0; i < n; i++) {
            if (blossomMark[base[i]]) {
              base[i] = curBase;
              if (!used[i]) {
                used[i] = true;
                queue.push(i);
              }
            }
          }
        } else if (p[to] === -1) {
          p[to] = v;
          if (match[to] === -1) {
            // Augmenting path found; flip it.
            let cur = to;
            while (cur !== -1) {
              const pv = p[cur];
              const ppv = match[pv];
              match[cur] = pv;
              match[pv] = cur;
              cur = ppv;
            }
            return true;
          } else {
            used[match[to]] = true;
            queue.push(match[to]);
          }
        }
      }
    }
    return false;
  };

  for (let v = 0; v < n; v++) {
    if (match[v] === -1) augmentFrom(v);
  }

  // ── 4. Recover edge ids from the final match[] vector. ──
  // A pair (i, match[i]) with i < match[i] is a matched edge;
  // find any edge with those endpoints.
  const result: number[] = [];
  const claimed = new Set<number>();
  for (let i = 0; i < n; i++) {
    const j = match[i];
    if (j > i && !claimed.has(i) && !claimed.has(j)) {
      const nodeA = vertices[i];
      const nodeB = vertices[j];
      const edge = edges.find(e =>
        (e.node_a === nodeA && e.node_b === nodeB) ||
        (e.node_a === nodeB && e.node_b === nodeA),
      );
      if (edge) {
        result.push(edge.id);
        claimed.add(i);
        claimed.add(j);
      }
    }
  }
  return result;
}

/**
 * Legacy entry point. Kept for callers that still import
 * `greedyMatching`; routes through the new maximum-matching
 * implementation so existing priority functions keep working.
 */
export function greedyMatching(
  edges: Edge[],
  priority?: (e: Edge) => number,
  // `restarts` is ignored — maximumMatching is deterministic given
  // a priority function and doesn't need random restarts.
  _restarts?: number,
): number[] {
  void _restarts;
  return maximumMatching(edges, priority);
}

/**
 * Check whether a set of edge ids is a valid matching on the given
 * edge list (no node appears in two edges). Used as an invariant
 * assertion after LP enforcement.
 */
export function isValidMatching(edges: Edge[], matchingIds: number[]): boolean {
  const seen = new Set<number>();
  for (const mid of matchingIds) {
    const e = edges.find(x => x.id === mid);
    if (!e) return false;
    if (seen.has(e.node_a) || seen.has(e.node_b)) return false;
    seen.add(e.node_a); seen.add(e.node_b);
  }
  return true;
}

/**
 * Swap one edge of `matching` for another that keeps it a valid
 * matching and changes its intersection with `conflict`. Used by
 * ALTERNATIVE_MATCHING when the LP is infeasible for the current
 * choice.
 */
export function perturbMatching(
  edges: Edge[],
  matching: number[],
  seed: number,
): number[] {
  if (matching.length === 0) return matching;
  const dropIdx = seed % matching.length;
  const dropped = matching[dropIdx];
  const rest = matching.filter((_, i) => i !== dropIdx);

  // Find a new compatible edge not already in the matching
  const restSet = new Set(rest);
  const shuffled = edges
    .filter(e => !restSet.has(e.id) && e.id !== dropped)
    .sort(() => Math.random() - 0.5);
  for (const cand of shuffled) {
    if (compatible(new Set(rest), edges, cand)) {
      return [...rest, cand.id];
    }
  }
  return matching;
}

// ─── Matching enumeration for beam search ─────────────────

/**
 * Generate a sequence of *candidate* maximum matchings ordered
 * roughly by "how well they fit the current W structure". The
 * beam-search driver in `searchClass1.ts` feeds the top
 * candidates to the LP as alternative strut sets when the first
 * one fails.
 *
 * Strategy:
 *   1. `strutness = max_j(-W[e,j])`: the most compressive
 *      self-stress assignment any column gives to e. Edges that
 *      are already "trying to be struts" in some basis direction
 *      get high priority.
 *   2. `totalMag = Σ_j |W[e,j]|`: total W magnitude. A
 *      longer-in-all-directions edge.
 *   3. One-edge swaps from candidate (1): for every edge of the
 *      base matching, try replacing it with every non-matching
 *      edge, keeping those that form a valid matching.
 *
 * Returns at most `maxCandidates` distinct matchings (identified
 * by their sorted edge-id signature).
 */
export function enumerateMatchings(
  edges: Edge[],
  W: number[][],
  memberIdx: Map<number, number>,
  maxCandidates: number = 16,
): number[][] {
  if (edges.length === 0 || W.length === 0 || (W[0]?.length ?? 0) === 0) {
    return [];
  }

  const k = W[0].length;
  const out: number[][] = [];
  const seen = new Set<string>();

  const sigOf = (m: number[]): string =>
    [...m].sort((a, b) => a - b).join(',');
  const addIfNew = (m: number[]) => {
    if (m.length === 0) return;
    const s = sigOf(m);
    if (seen.has(s)) return;
    seen.add(s);
    out.push(m);
  };

  // Priority 1: strutness = -min_j W[e,j]
  addIfNew(maximumMatching(edges, (e) => {
    const i = memberIdx.get(e.id);
    if (i === undefined) return 0;
    let mostNeg = 0;
    for (let j = 0; j < k; j++) {
      if (W[i][j] < mostNeg) mostNeg = W[i][j];
    }
    return -mostNeg;
  }));

  // Priority 2: total magnitude sum
  addIfNew(maximumMatching(edges, (e) => {
    const i = memberIdx.get(e.id);
    if (i === undefined) return 0;
    let s = 0;
    for (let j = 0; j < k; j++) s += Math.abs(W[i][j]);
    return s;
  }));

  // Priority 3: max absolute W value (peak rather than sum)
  addIfNew(maximumMatching(edges, (e) => {
    const i = memberIdx.get(e.id);
    if (i === undefined) return 0;
    let m = 0;
    for (let j = 0; j < k; j++) {
      const v = Math.abs(W[i][j]);
      if (v > m) m = v;
    }
    return m;
  }));

  // Priority 4+: single-edge swaps from the base matching
  if (out.length > 0) {
    const base = [...out[0]];
    const baseSet = new Set(base);
    const outside = edges.filter(e => !baseSet.has(e.id));
    outer: for (const eOut of base) {
      for (const eIn of outside) {
        const alt = base.filter(x => x !== eOut).concat(eIn.id);
        if (isValidMatching(edges, alt)) {
          addIfNew(alt);
          if (out.length >= maxCandidates) break outer;
        }
      }
    }
  }

  return out.slice(0, maxCandidates);
}
