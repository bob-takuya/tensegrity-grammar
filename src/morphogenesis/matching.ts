/**
 * Maximum matching utilities for Class-1 enforcement.
 *
 * For the sizes this app produces (|V| ≤ 50), a plain augmenting-path
 * algorithm on non-bipartite graphs (Micali–Vazirani-lite) is total
 * overkill; a simple greedy + local improvement gives a near-maximum
 * matching in practice. Since we only need "some matching of size as
 * large as possible", we run a randomised greedy several times and
 * keep the best.
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

/** Greedy randomised matching with K restarts. */
export function greedyMatching(
  edges: Edge[],
  priority?: (e: Edge) => number,
  restarts: number = 24,
): number[] {
  if (edges.length === 0) return [];

  let bestMatching: number[] = [];
  for (let r = 0; r < restarts; r++) {
    const order = [...edges];
    if (priority) {
      // Sort high-priority first, break ties randomly
      order.sort((a, b) => {
        const pa = priority(a), pb = priority(b);
        if (pa !== pb) return pb - pa;
        return Math.random() - 0.5;
      });
    } else {
      order.sort(() => Math.random() - 0.5);
    }
    const current = new Set<number>();
    for (const e of order) {
      if (compatible(current, edges, e)) current.add(e.id);
    }
    if (current.size > bestMatching.length) {
      bestMatching = [...current];
    }
  }
  return bestMatching;
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
