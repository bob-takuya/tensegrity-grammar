import { createEmptyState, autoGrow } from './src/morphogenesis/engine';

console.log('=== Class-1 vs Unconstrained ===\n');

for (const maxCompDeg of [1, 2, 3, Infinity]) {
  let totalMaxComp = 0, totalCells = 0, totalNodes = 0, trials = 10;
  for (let t = 0; t < trials; t++) {
    const s = createEmptyState();
    autoGrow(s, 8, { spread: 0.5, fuseProbability: 0.2, maxCompDeg });
    totalCells += s.cells.length;
    totalNodes += s.graph.nodes.length;

    let mc = 0;
    for (const n of s.graph.nodes) {
      const deg = s.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length;
      mc = Math.max(mc, deg);
    }
    totalMaxComp += mc;
  }
  const label = maxCompDeg === Infinity ? '∞' : maxCompDeg.toString();
  console.log(`maxCompDeg=${label}: avg_class=${(totalMaxComp/trials).toFixed(1)} avg_cells=${(totalCells/trials).toFixed(0)} avg_nodes=${(totalNodes/trials).toFixed(0)}`);
}
