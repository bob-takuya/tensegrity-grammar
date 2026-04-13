import {
  createEmptyState, autoGrow, verifyEquilibrium, dimW,
} from './src/morphogenesis/engine';

console.log('=== K₅ Cellular Morphogenesis Test ===\n');

for (const numCells of [1, 3, 5, 8, 12]) {
  let eqPass = 0;
  const total = 10;
  let avgNodes = 0, avgMembers = 0, avgStruts = 0, avgCables = 0, avgBasis = 0;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, numCells, { spread: 0.5, fuseProbability: 0.5 });
    if (verifyEquilibrium(s) < 1e-6) eqPass++;

    avgNodes += s.nodes.length;
    avgMembers += s.members.length;
    avgStruts += s.members.filter(m => m.type === 'strut').length;
    avgCables += s.members.filter(m => m.type === 'cable').length;
    avgBasis += dimW(s);
  }
  console.log(
    `cells=${numCells.toString().padStart(2)}: eq=${eqPass}/${total} ` +
    `avg=(${(avgNodes / total).toFixed(0)}n ${(avgMembers / total).toFixed(0)}m ` +
    `${(avgStruts / total).toFixed(0)}S ${(avgCables / total).toFixed(0)}C) ` +
    `dimW=${(avgBasis / total).toFixed(1)}`
  );
}

// Detailed single run
console.log('\n=== Detailed (5 cells) ===');
const s = createEmptyState();
autoGrow(s, 5, { spread: 0.5, fuseProbability: 0.5 });

const struts = s.members.filter(m => m.type === 'strut').length;
const cables = s.members.filter(m => m.type === 'cable').length;
console.log(`Nodes: ${s.nodes.length}, Members: ${s.members.length}, Cells: ${s.cells.length}`);
console.log(`Struts: ${struts}, Cables: ${cables}, dim W: ${dimW(s)}`);
console.log(`Equilibrium residual: ${verifyEquilibrium(s).toExponential(2)}`);

console.log('\nMorphogenesis steps:');
for (const step of s.morphogenesisSteps) {
  console.log(
    `  step ${step.step_id} ${step.operation.padEnd(8)} ` +
    `Δe=${step.delta_e.toString().padStart(3)} ` +
    `Δv=${step.delta_v.toString().padStart(3)} ` +
    `pred=${step.delta_dim_W_predicted.toString().padStart(3)} ` +
    `act=${step.delta_dim_W_actual.toString().padStart(3)}`
  );
}

console.log('\nPer-node strut degree distribution:');
const distrib = new Map<number, number>();
for (const n of s.nodes) {
  const deg = s.members.filter(m =>
    m.type === 'strut' && (m.node_a === n.node_id || m.node_b === n.node_id)
  ).length;
  distrib.set(deg, (distrib.get(deg) || 0) + 1);
}
for (const [deg, count] of [...distrib.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${deg} struts: ${count} nodes`);
}
