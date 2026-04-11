import { DiagramData } from './src/types';
import { autoExploreForceGrammar, ForceGrammarState } from './src/grammar/forceGrammar';
import { findNullspaceBasis } from './src/engine/linalg';

const empty: DiagramData = { nodes: [], edges: [] };
const fg: ForceGrammarState = { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: false };

function checkSS(d: DiagramData): boolean {
  const m = d.edges.length, n = d.nodes.length;
  if (m === 0) return false;
  const nodeIdx = new Map(d.nodes.map((nd, i) => [nd.id, i]));
  const A: number[][] = Array.from({ length: 3 * n }, () => new Array(m).fill(0));
  for (let e = 0; e < m; e++) {
    const src = d.nodes.find(nd => nd.id === d.edges[e].source)!;
    const tgt = d.nodes.find(nd => nd.id === d.edges[e].target)!;
    const dx = tgt.x-src.x, dy = tgt.y-src.y, dz = tgt.z-src.z;
    const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (len < 1e-10) continue;
    const iS = nodeIdx.get(d.edges[e].source)!, iT = nodeIdx.get(d.edges[e].target)!;
    A[3*iS][e]=dx/len; A[3*iS+1][e]=dy/len; A[3*iS+2][e]=dz/len;
    A[3*iT][e]=-dx/len; A[3*iT+1][e]=-dy/len; A[3*iT+2][e]=-dz/len;
  }
  const basis = findNullspaceBasis(A);
  if (basis.length === 0) return false;
  for (const raw of basis) {
    for (const sign of [1, -1]) {
      const v = raw.map(x => x * sign);
      if (d.edges.every((e, i) => (e.elementType === 'compression' ? v[i] <= 0.001 : v[i] >= -0.001))) return true;
    }
  }
  return false;
}

console.log('=== Cellular Morphogenesis: Full Prism Stacking ===\n');

for (const steps of [1, 2, 3, 5, 8, 10]) {
  let valid = 0, total = 10;
  let avgN = 0, avgP = 0, avgC = 0;
  for (let t = 0; t < total; t++) {
    const r = autoExploreForceGrammar(empty, fg, steps, 3);
    const d = r.diagram;
    if (checkSS(d)) valid++;
    avgN += d.nodes.length;
    avgP += d.edges.filter(e => e.elementType === 'compression').length;
    avgC += d.edges.filter(e => e.elementType === 'tension').length;
  }
  console.log(`steps=${steps.toString().padStart(2)}: stress=${valid}/${total} avg=(${(avgN/total).toFixed(0)}n ${(avgP/total).toFixed(0)}p ${(avgC/total).toFixed(0)}c)`);
}

// Show a detailed 3-step run
console.log('\n=== Detailed (3 steps) ===');
const r = autoExploreForceGrammar(empty, fg, 3, 3);
const d = r.diagram;
console.log(`Nodes: ${d.nodes.length}, Plates: ${d.edges.filter(e=>e.elementType==='compression').length}, Cables: ${d.edges.filter(e=>e.elementType==='tension').length}`);
console.log(`Self-stress: ${checkSS(d)}`);
console.log('\nNodes by z:');
const byZ = [...d.nodes].sort((a, b) => a.z - b.z);
for (const n of byZ) {
  const cd = d.edges.filter(e => e.elementType === 'compression' && (e.source === n.id || e.target === n.id)).length;
  const td = d.edges.filter(e => e.elementType === 'tension' && (e.source === n.id || e.target === n.id)).length;
  console.log(`  z=${n.z.toFixed(2)} comp=${cd} cable=${td}`);
}
