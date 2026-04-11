import { createEmptyState, autoGrow, verifyEquilibrium } from './src/morphogenesis/engine';

console.log('=== Structural Validity + Class-k Check ===\n');

for (const maxCompDeg of [1, 2, 3, Infinity]) {
  let eqPass = 0, totalMaxComp = 0, total = 10;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, 8, { spread: 0.5, fuseProbability: 0.1, maxCompDeg });
    const res = verifyEquilibrium(s.graph.nodes, s.graph.edges);
    if (res < 1e-6) eqPass++;
    let mc = 0;
    for (const n of s.graph.nodes) {
      const deg = s.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length;
      mc = Math.max(mc, deg);
    }
    totalMaxComp += mc;
  }
  const label = maxCompDeg === Infinity ? '∞' : maxCompDeg.toString();
  console.log(`maxCompDeg=${label}: equilibrium=${eqPass}/${total} avg_class=${(totalMaxComp/total).toFixed(1)}`);
}
