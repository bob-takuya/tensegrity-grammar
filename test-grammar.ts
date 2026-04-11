/**
 * Local test for L-system tensegrity grammar.
 * Run: npx tsx test-grammar.ts
 */

import { DiagramData } from './src/types';
import { autoExploreForceGrammar, ForceGrammarState } from './src/grammar/forceGrammar';

const diagram: DiagramData = {
  nodes: [
    { id: 'n0', x: -2, y: -1, z: 0, support: 'pin', externalForce: { x: 0, y: 0 } },
    { id: 'n1', x: 2, y: -1, z: 0, support: 'pin', externalForce: { x: 0, y: 0 } },
    { id: 'n2', x: 0, y: 2, z: 0, support: 'pin', externalForce: { x: 0, y: 0 } },
  ],
  edges: [],
};

const fg: ForceGrammarState = {
  active: true, interimForces: [], selectedForceId: null,
  feasibilityDomain: null, isComplete: false,
};

function validate(d: DiagramData): { valid: boolean; plates: number; cables: number; issues: string[] } {
  const plates = d.edges.filter(e => e.elementType === 'compression');
  const cables = d.edges.filter(e => e.elementType === 'tension');
  const issues: string[] = [];

  // 1. No node has more than 1 compression member
  for (const node of d.nodes) {
    const cd = d.edges.filter(e =>
      e.elementType === 'compression' && (e.source === node.id || e.target === node.id)
    ).length;
    if (cd > 1) issues.push(`Node (${node.x.toFixed(1)},${node.y.toFixed(1)},${node.z.toFixed(1)}) has ${cd} compression`);
  }

  // 2. All plates should have 2 distinct endpoints
  for (const p of plates) {
    if (p.source === p.target) issues.push(`Self-loop plate ${p.id}`);
  }

  // 3. Tension network should be connected (if any cables exist)
  if (cables.length > 0) {
    const tensionNodes = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const c of cables) {
      tensionNodes.add(c.source);
      tensionNodes.add(c.target);
      if (!adj.has(c.source)) adj.set(c.source, []);
      if (!adj.has(c.target)) adj.set(c.target, []);
      adj.get(c.source)!.push(c.target);
      adj.get(c.target)!.push(c.source);
    }
    // Also add plate endpoints to the tension network check
    for (const p of plates) {
      tensionNodes.add(p.source);
      tensionNodes.add(p.target);
    }
    // BFS from first cable node
    const visited = new Set<string>();
    const q = [cables[0].source];
    visited.add(cables[0].source);
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const nb of (adj.get(cur) || [])) {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
      }
    }
    const unreachable = [...tensionNodes].filter(n => !visited.has(n));
    if (unreachable.length > 0) {
      issues.push(`Tension network disconnected: ${unreachable.length} unreachable nodes`);
    }
  }

  // 4. Every non-support free node should have at least 2 edges total
  for (const node of d.nodes) {
    if (node.support !== 'free') continue;
    const deg = d.edges.filter(e => e.source === node.id || e.target === node.id).length;
    if (deg < 2) issues.push(`Isolated free node (${node.x.toFixed(1)},${node.y.toFixed(1)},${node.z.toFixed(1)}) deg=${deg}`);
  }

  return { valid: issues.length === 0, plates: plates.length, cables: cables.length, issues };
}

// Run 10 trials of each step count
console.log('=== L-System Tensegrity Grammar Test ===\n');

for (const steps of [1, 3, 5, 10, 15, 20]) {
  let pass = 0, fail = 0;
  const allIssues: string[] = [];
  for (let trial = 0; trial < 10; trial++) {
    const result = autoExploreForceGrammar(diagram, fg, steps, 3);
    const v = validate(result.diagram);
    if (v.valid) {
      pass++;
    } else {
      fail++;
      for (const issue of v.issues) {
        if (!allIssues.includes(issue)) allIssues.push(issue);
      }
    }
  }
  const sym = fail === 0 ? '✓' : '✗';
  console.log(`${sym} steps=${steps}: ${pass}/10 valid, ${fail}/10 invalid`);
  if (allIssues.length > 0) {
    for (const issue of allIssues.slice(0, 3)) console.log(`    ${issue}`);
  }
}

// Detailed single run for steps=5
console.log('\n=== Detailed run (5 plates) ===\n');
const r = autoExploreForceGrammar(diagram, fg, 5, 3);
const v = validate(r.diagram);
console.log(`Nodes: ${r.diagram.nodes.length}, Plates: ${v.plates}, Cables: ${v.cables}`);
console.log(`Valid: ${v.valid}`);
if (v.issues.length > 0) console.log('Issues:', v.issues);
console.log('\nStructure:');
for (const e of r.diagram.edges) {
  const src = r.diagram.nodes.find(n => n.id === e.source)!;
  const tgt = r.diagram.nodes.find(n => n.id === e.target)!;
  const label = e.elementType === 'compression' ? 'PLATE' : 'cable';
  console.log(`  ${label}: (${src.x.toFixed(1)},${src.y.toFixed(1)},${src.z.toFixed(1)}) -> (${tgt.x.toFixed(1)},${tgt.y.toFixed(1)},${tgt.z.toFixed(1)})`);
}
