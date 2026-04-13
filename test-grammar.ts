import { createEmptyState, autoGrow, verifyEquilibrium } from './src/morphogenesis/engine';

console.log('=== K₅ Cellular Morphogenesis Test ===\n');

for (const numCells of [1, 3, 5, 8, 12]) {
  let eqPass = 0, total = 10;
  let avgNodes = 0, avgEdges = 0, avgStruts = 0, avgCables = 0, avgBasis = 0;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, numCells, { spread: 0.5, fuseProbability: 0.5 });
    const res = verifyEquilibrium(s.graph.nodes, s.graph.edges);
    if (res < 1e-6) eqPass++;

    avgNodes += s.graph.nodes.length;
    avgEdges += s.graph.edges.length;
    avgStruts += s.graph.edges.filter(e => e.type === 'strut').length;
    avgCables += s.graph.edges.filter(e => e.type === 'cable').length;
    avgBasis += s.stressBasis.length;
  }
  console.log(`cells=${numCells.toString().padStart(2)}: eq=${eqPass}/${total} avg=(${(avgNodes/total).toFixed(0)}n ${(avgEdges/total).toFixed(0)}e ${(avgStruts/total).toFixed(0)}S ${(avgCables/total).toFixed(0)}C) basis=${(avgBasis/total).toFixed(1)}`);
}

// Detailed single run
console.log('\n=== Detailed (5 cells) ===');
const s = createEmptyState();
autoGrow(s, 5, { spread: 0.5, fuseProbability: 0.5 });

console.log(`Nodes: ${s.graph.nodes.length}, Edges: ${s.graph.edges.length}, Cells: ${s.cells.length}`);
const struts = s.graph.edges.filter(e => e.type === 'strut').length;
const cables = s.graph.edges.filter(e => e.type === 'cable').length;
console.log(`Struts: ${struts}, Cables: ${cables}, Self-stress dim: ${s.stressBasis.length}`);
console.log(`Equilibrium residual: ${verifyEquilibrium(s.graph.nodes, s.graph.edges).toExponential(2)}`);

console.log('\nPer-node strut degree distribution:');
const distrib = new Map<number, number>();
for (const n of s.graph.nodes) {
  const deg = s.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length;
  distrib.set(deg, (distrib.get(deg) || 0) + 1);
}
for (const [deg, count] of [...distrib.entries()].sort((a,b) => a[0]-b[0])) {
  console.log(`  ${deg} struts: ${count} nodes`);
}
