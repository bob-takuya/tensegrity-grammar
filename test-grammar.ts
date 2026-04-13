import { createEmptyState, autoGrow, verifyEquilibrium } from './src/morphogenesis/engine';

console.log('=== Prism-Based Tensegrity Test ===\n');

for (const numCells of [1, 2, 3, 5, 8]) {
  let eqPass = 0, class1Count = 0, total = 10;
  let avgCableOnly = 0, avgMaxStrut = 0;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, numCells, { spread: 0.2 });
    const res = verifyEquilibrium(s.graph.nodes, s.graph.edges);
    if (res < 1e-6) eqPass++;

    let cableOnly = 0, maxS = 0, multiS = 0;
    for (const n of s.graph.nodes) {
      const deg = s.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length;
      if (deg === 0) cableOnly++;
      if (deg > 1) multiS++;
      maxS = Math.max(maxS, deg);
    }
    avgCableOnly += cableOnly;
    avgMaxStrut += maxS;
    if (cableOnly === 0 && multiS === 0) class1Count++;
  }
  console.log(`cells=${numCells}: eq=${eqPass}/${total} class1=${class1Count}/${total} avgCableOnly=${(avgCableOnly/total).toFixed(1)} avgMaxStrut=${(avgMaxStrut/total).toFixed(1)}`);
}
