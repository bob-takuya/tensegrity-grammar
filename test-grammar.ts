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
  if (basis.length === 0) return { valid: false, detail: 'no self-stress (rank=m)' };
  for (const raw of basis) {
    for (const sign of [1, -1]) {
      const v = raw.map(x => x * sign);
      const ok = d.edges.every((e, i) =>
        (e.elementType === 'compression' ? v[i] <= 0.001 : v[i] >= -0.001)
      );
      if (ok) return { valid: true, detail: `nulldim=${basis.length}` };
    }
  }
  return { valid: false, detail: `nulldim=${basis.length} wrong signs` };
}

console.log('=== Full Tensegrity Verification ===\n');
console.log('Testing SEED (force-density form-finding) + SPROUT/BRANCH growth\n');

for (const steps of [3, 5, 7, 10]) {
  let validSS = 0, validTopo = 0, total = 20;
  for (let trial = 0; trial < total; trial++) {
    const r = autoExploreForceGrammar(empty, fg, steps, 3);
    const d = r.diagram;
    // Topology check
    const topoOk = d.nodes.every(nd =>
      d.edges.filter(e => e.elementType === 'compression' && (e.source === nd.id || e.target === nd.id)).length <= 1
    );
    if (topoOk) validTopo++;
    // Self-stress check (only on SEED, before SPROUT/BRANCH)
    const ss = checkSelfStress(d);
    if (ss.valid) validSS++;
  }
  console.log(`steps=${steps.toString().padStart(2)}: topo=${validTopo}/${total} self-stress=${validSS}/${total}`);
}
