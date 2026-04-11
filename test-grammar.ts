import { DiagramData } from './src/types';
import { autoExploreForceGrammar, ForceGrammarState } from './src/grammar/forceGrammar';
import { findNullspaceBasis } from './src/engine/linalg';

const empty: DiagramData = { nodes: [], edges: [] };
const fg: ForceGrammarState = { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: false };

function checkSelfStress(d: DiagramData): { valid: boolean; detail: string } {
  const m = d.edges.length, n = d.nodes.length;
  if (m === 0) return { valid: false, detail: 'empty' };
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
  if (basis.length === 0) return { valid: false, detail: 'no self-stress (nullspace=0)' };
  for (const raw of basis) {
    for (const sign of [1, -1]) {
      const v = raw.map(x => x * sign);
      const ok = d.edges.every((e, i) => (e.elementType === 'compression' ? v[i] <= 0.001 : v[i] >= -0.001));
      if (ok) return { valid: true, detail: `nullspace=${basis.length}` };
    }
  }
  return { valid: false, detail: `nullspace=${basis.length} (wrong signs)` };
}

function checkTensegrityTopo(d: DiagramData): boolean {
  return d.nodes.every(n =>
    d.edges.filter(e => e.elementType === 'compression' && (e.source === n.id || e.target === n.id)).length <= 1
  );
}

console.log('=== Cellular Morphogenesis Test ===\n');

for (const steps of [1, 2, 3, 5, 8]) {
  let valid = 0, topo = 0, total = 20;
  let plates = 0, cables = 0, nodes = 0;
  for (let trial = 0; trial < total; trial++) {
    const r = autoExploreForceGrammar(empty, fg, steps, 3);
    const d = r.diagram;
    if (checkTensegrityTopo(d)) topo++;
    if (checkSelfStress(d).valid) valid++;
    plates += d.edges.filter(e => e.elementType === 'compression').length;
    cables += d.edges.filter(e => e.elementType === 'tension').length;
    nodes += d.nodes.length;
  }
  console.log(`steps=${steps.toString().padStart(2)}: topo=${topo}/${total} stress=${valid}/${total} avg=(${(nodes/total).toFixed(0)}n ${(plates/total).toFixed(0)}p ${(cables/total).toFixed(0)}c)`);
}

// Detailed run
console.log('\n=== Detailed (steps=3) ===');
const r = autoExploreForceGrammar(empty, fg, 3, 3);
const d = r.diagram;
const p = d.edges.filter(e => e.elementType === 'compression');
const c = d.edges.filter(e => e.elementType === 'tension');
console.log(`Nodes: ${d.nodes.length}, Plates: ${p.length}, Cables: ${c.length}`);
console.log(`Topo valid: ${checkTensegrityTopo(d)}`);
const ss = checkSelfStress(d);
console.log(`Self-stress: ${ss.valid} (${ss.detail})`);

// Print structure
for (const e of d.edges) {
  const s = d.nodes.find(n => n.id === e.source)!;
  const t = d.nodes.find(n => n.id === e.target)!;
  const label = e.elementType === 'compression' ? 'PLATE' : 'cable';
  console.log(`  ${label}: (${s.x.toFixed(1)},${s.y.toFixed(1)},${s.z.toFixed(1)}) → (${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)})`);
}
