import { computeK5SelfStress, classifySignPattern, verifyEquilibrium, k5EdgePairs } from './src/morphogenesis/k5cell';
import { createEmptyState, seed, autoGrow } from './src/morphogenesis/engine';
import { Vec3 } from './src/morphogenesis/types';
import { isGeneralPosition } from './src/morphogenesis/geometry';

// ─── Test 1: K₅ self-stress ─────────────────────────────────────

console.log('=== Test 1: K₅ Self-Stress (100 random trials) ===\n');

let pass = 0, fail = 0, signI = 0, signII = 0;
for (let t = 0; t < 100; t++) {
  const pts: Vec3[] = Array.from({ length: 5 }, () => [
    (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4,
  ]);
  if (!isGeneralPosition(pts)) continue;

  const w = computeK5SelfStress(pts);
  if (!w) { fail++; continue; }

  const sign = classifySignPattern(w);
  if (sign === 'typeI') signI++; else signII++;

  // Verify equilibrium
  const nodes = pts.map((p, i) => ({ id: i, pos: p }));
  const pairs = k5EdgePairs();
  const edges = pairs.map(([a, b], i) => ({ id: i, n: [a, b] as [number, number], forceDensity: w[i] }));
  const res = verifyEquilibrium(nodes, edges);

  if (res < 1e-8) pass++;
  else { fail++; if (fail <= 3) console.log(`  FAIL trial ${t}: residual=${res.toExponential(2)}`); }
}

console.log(`Equilibrium: ${pass} pass, ${fail} fail (of ${pass + fail})`);
console.log(`Type I (≥6 positive): ${signI}, Type II: ${signII}`);

// ─── Test 2: Seed ────────────────────────────────────────────────

console.log('\n=== Test 2: Seed K₅ Cell ===\n');

const st = createEmptyState();
seed(st, [[1.5,0,0], [-0.75,1.3,0], [-0.75,-1.3,0], [0,0,2], [0.3,0.5,1]]);
console.log(`Nodes: ${st.graph.nodes.length}, Edges: ${st.graph.edges.length}`);
console.log(`Cells: ${st.cells.length}, Stress dim: ${st.stressBasis.length}`);
const nS = st.graph.edges.filter(e => e.type === 'strut').length;
const nC = st.graph.edges.filter(e => e.type === 'cable').length;
console.log(`Struts: ${nS}, Cables: ${nC}`);

// ─── Test 3: Auto-grow ──────────────────────────────────────────

console.log('\n=== Test 3: Auto-Grow (non-linear) ===\n');

for (const numCells of [3, 5, 8, 10]) {
  let ok = 0, total = 5;
  let avgN = 0, avgE = 0, avgDim = 0;
  for (let t = 0; t < total; t++) {
    const s = createEmptyState();
    autoGrow(s, numCells, { spread: 0.5, fuseProbability: 0.2 });
    if (s.cells.length >= numCells * 0.5) ok++;
    avgN += s.graph.nodes.length;
    avgE += s.graph.edges.length;
    avgDim += s.stressBasis.length;
  }
  console.log(`target=${numCells.toString().padStart(2)}: ${ok}/${total} ok, avg=(${(avgN/total).toFixed(0)}n ${(avgE/total).toFixed(0)}e dim=${(avgDim/total).toFixed(1)})`);
}

// ─── Test 4: Growth variety ──────────────────────────────────────

console.log('\n=== Test 4: Shape Variety ===\n');

const s4 = createEmptyState();
autoGrow(s4, 8, { spread: 0.8 });
const xs = s4.graph.nodes.map(n => n.pos[0]);
const ys = s4.graph.nodes.map(n => n.pos[1]);
const zs = s4.graph.nodes.map(n => n.pos[2]);
const xr = Math.max(...xs) - Math.min(...xs);
const yr = Math.max(...ys) - Math.min(...ys);
const zr = Math.max(...zs) - Math.min(...zs);
console.log(`Bounding box: X=${xr.toFixed(1)} Y=${yr.toFixed(1)} Z=${zr.toFixed(1)}`);
console.log(`Cells: ${s4.cells.length}, Nodes: ${s4.graph.nodes.length}, Edges: ${s4.graph.edges.length}`);
console.log(`Non-tower: ${Math.max(xr, yr) > 2 ? '✓' : '✗'}`);
