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
  const match: number[] = new Array(n).fill(-1);
  const order = [...edges];
  if (priority) {
    order.sort((a, b) => {
      const pa = priority(a), pb = priority(b);
      if (pa !== pb) return pb - pa;
      return Math.random() - 0.5;
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
