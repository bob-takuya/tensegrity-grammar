import { DiagramData } from './src/types';
import { autoExploreForceGrammar, ForceGrammarState } from './src/grammar/forceGrammar';
import { findNullspaceBasis } from './src/engine/linalg';

const empty: DiagramData = { nodes: [], edges: [] };
const fg: ForceGrammarState = { active: true, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: false };

function checkSelfStress(d: DiagramData): { valid: boolean; nulldim: number } {
  const m = d.edges.length, n = d.nodes.length;
  if (m === 0) return { valid: false, nulldim: 0 };
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
  if (basis.length === 0) return { valid: false, nulldim: 0 };
  for (const raw of basis) {
    for (const sign of [1, -1]) {
      const v = raw.map(x => x * sign);
      if (d.edges.every((e, i) => (e.elementType === 'compression' ? v[i] <= 0.001 : v[i] >= -0.001)))
        return { valid: true, nulldim: basis.length };
    }
  }
  return { valid: false, nulldim: basis.length };
}

console.log('=== Final Test: Cellular Morphogenesis ===\n');

for (const steps of [1, 2, 3, 5, 8, 10]) {
  let valid = 0, total = 10;
  let avgN = 0, avgP = 0, avgC = 0, avgNull = 0;
  for (let t = 0; t < total; t++) {
    const r = autoExploreForceGrammar(empty, fg, steps, 3);
    const d = r.diagram;
    const ss = checkSelfStress(d);
    if (ss.valid) valid++;
    avgNull += ss.nulldim;
    avgN += d.nodes.length;
    avgP += d.edges.filter(e => e.elementType === 'compression').length;
    avgC += d.edges.filter(e => e.elementType === 'tension').length;
  }
  console.log(`steps=${steps.toString().padStart(2)}: stress=${valid}/${total} null=${(avgNull/total).toFixed(1)} avg=(${(avgN/total).toFixed(0)}n ${(avgP/total).toFixed(0)}p ${(avgC/total).toFixed(0)}c)`);
}
