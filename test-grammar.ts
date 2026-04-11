import { createEmptyState, autoGrow, verifyEquilibrium } from './src/morphogenesis/engine';

console.log('=== Type II Tetrahedral Cell Test ===\n');

for (const numCells of [3, 5, 8, 10]) {
  let eqPass = 0, cableOnlyTotal = 0, maxClassTotal = 0, surfaceMaxClass = 0, total = 10;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, numCells, { spread: 0.5, maxCompDeg: 1 });
    const res = verifyEquilibrium(s.graph.nodes, s.graph.edges);
    if (res < 1e-6) eqPass++;

    let cableOnly = 0, maxClass = 0, surfMax = 0;
    for (const n of s.graph.nodes) {
      const strutDeg = s.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length;
      if (strutDeg === 0) cableOnly++;
      maxClass = Math.max(maxClass, strutDeg);
      // Surface nodes are those that are NOT centroids (centroids have 4+ struts by design)
      if (strutDeg > 0 && strutDeg <= 2) surfMax = Math.max(surfMax, strutDeg);
    }
    cableOnlyTotal += cableOnly;
    maxClassTotal += maxClass;
    surfaceMaxClass += surfMax;
  }
  console.log(`cells=${numCells.toString().padStart(2)}: eq=${eqPass}/${total} cableOnly=${(cableOnlyTotal/total).toFixed(1)} maxClass=${(maxClassTotal/total).toFixed(1)} surfaceClass=${(surfaceMaxClass/total).toFixed(1)}`);
}
