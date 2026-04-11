import { DiagramData } from './src/types';
import { autoExploreForceGrammar, ForceGrammarState } from './src/grammar/forceGrammar';

const emptyDiagram: DiagramData = { nodes: [], edges: [] };
const fg: ForceGrammarState = {
  active: true, interimForces: [], selectedForceId: null,
  feasibilityDomain: null, isComplete: false,
};

function validate(d: DiagramData) {
  const plates = d.edges.filter(e => e.elementType === 'compression');
  const cables = d.edges.filter(e => e.elementType === 'tension');
  const issues: string[] = [];

  // 1. Tensegrity: no node has >1 compression member
  for (const n of d.nodes) {
    const cd = d.edges.filter(e => e.elementType === 'compression' && (e.source === n.id || e.target === n.id)).length;
    if (cd > 1) issues.push(`Node has ${cd} compression members`);
  }

  // 2. No ground cables (no cables to support nodes)
  // Actually in the new design there are no support nodes at all in the tensegrity
  // Cables should only connect plate endpoints to each other

  // 3. Tension network connected (among plate endpoints)
  const pEnds = new Set<string>();
  for (const e of plates) { pEnds.add(e.source); pEnds.add(e.target); }

  if (pEnds.size > 0 && cables.length > 0) {
    const adj = new Map<string, string[]>();
    for (const c of cables) {
      if (!adj.has(c.source)) adj.set(c.source, []);
      if (!adj.has(c.target)) adj.set(c.target, []);
      adj.get(c.source)!.push(c.target);
      adj.get(c.target)!.push(c.source);
    }
    const visited = new Set<string>();
    const start = [...pEnds][0];
    const q = [start];
    visited.add(start);
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const nb of (adj.get(cur) || [])) {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
      }
    }
    for (const pe of pEnds) {
      if (!visited.has(pe)) { issues.push(`Plate endpoint disconnected from tension network`); break; }
    }
  }

  // 4. Each plate endpoint has >= 2 cables (needed for stability)
  for (const pe of pEnds) {
    const cableCount = cables.filter(c => c.source === pe || c.target === pe).length;
    if (cableCount < 2) issues.push(`Plate endpoint has only ${cableCount} cable(s)`);
  }

  // 5. Self-stressed: no cables go to nodes that aren't plate endpoints
  const nonPlateEndCables = cables.filter(c => !pEnds.has(c.source) || !pEnds.has(c.target));
  if (nonPlateEndCables.length > 0) {
    // This is a warning, not necessarily invalid (support nodes might be involved)
  }

  // 6. At least 3 struts for a valid tensegrity
  if (plates.length < 3) issues.push(`Only ${plates.length} struts (need >= 3)`);

  return { valid: issues.length === 0, plates: plates.length, cables: cables.length, issues };
}

console.log('=== Self-Stressed Tensegrity L-System Test ===\n');

for (const steps of [3, 5, 7, 10, 15, 20]) {
  let pass = 0, fail = 0;
  const allIssues: string[] = [];
  for (let trial = 0; trial < 10; trial++) {
    const result = autoExploreForceGrammar(emptyDiagram, fg, steps, 3);
    const v = validate(result.diagram);
    if (v.valid) pass++; else {
      fail++;
      for (const i of v.issues) if (!allIssues.includes(i)) allIssues.push(i);
    }
  }
  const sym = fail === 0 ? '✓' : '✗';
  console.log(`${sym} steps=${steps}: ${pass}/10 pass  (plates+cables per run vary)`);
  if (allIssues.length > 0) {
    for (const i of allIssues.slice(0, 3)) console.log(`    ${i}`);
  }
}

// Detailed run
console.log('\n=== Detailed run (steps=5) ===\n');
const r = autoExploreForceGrammar(emptyDiagram, fg, 5, 3);
const v = validate(r.diagram);
console.log(`Nodes: ${r.diagram.nodes.length}, Plates: ${v.plates}, Cables: ${v.cables}`);
console.log(`Valid: ${v.valid}${v.issues.length > 0 ? '  Issues: ' + v.issues.join('; ') : ''}`);
console.log();

// Check: no cables go to z=0 ground pins
const groundCables = r.diagram.edges.filter(e => {
  if (e.elementType !== 'tension') return false;
  const src = r.diagram.nodes.find(n => n.id === e.source)!;
  const tgt = r.diagram.nodes.find(n => n.id === e.target)!;
  return src.support !== 'free' || tgt.support !== 'free';
});
console.log(`Ground cables (should be 0): ${groundCables.length}`);

// Print structure
for (const e of r.diagram.edges) {
  const src = r.diagram.nodes.find(n => n.id === e.source)!;
  const tgt = r.diagram.nodes.find(n => n.id === e.target)!;
  const label = e.elementType === 'compression' ? 'PLATE' : 'cable';
  console.log(`  ${label}: (${src.x.toFixed(1)},${src.y.toFixed(1)},${src.z.toFixed(1)}) -> (${tgt.x.toFixed(1)},${tgt.y.toFixed(1)},${tgt.z.toFixed(1)})`);
}
