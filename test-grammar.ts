import { searchClass1Tensegrity } from './src/morphogenesis/searchClass1';
import { verifyEquilibrium, dimW } from './src/morphogenesis/engine';

async function main() {
  console.log('=== Class-1 Tensegrity Search ===\n');

  for (const n of [5, 8, 12, 16, 20]) {
    let okCount = 0, rigidCount = 0, class1Count = 0, timedOutCount = 0;
    const total = 5;
    let avgMembers = 0, avgStruts = 0, avgCables = 0, avgDimW = 0, avgEvents = 0;
    for (let t = 0; t < total; t++) {
      const r = await searchClass1Tensegrity(n, null, 42 + t, {
        // Run at full speed from Node — no setTimeout(0) between ticks.
        yieldToEventLoop: false,
        timeoutMs: 10_000,
      });
      if (r.success) okCount++;
      if (r.rigid) rigidCount++;
      if (r.class1) class1Count++;
      if (r.timedOut) timedOutCount++;
      avgMembers += r.state.members.length;
      avgStruts += r.state.members.filter(m => m.type === 'strut').length;
      avgCables += r.state.members.filter(m => m.type === 'cable').length;
      avgDimW += dimW(r.state);
      avgEvents += r.state.events.length;
    }
    console.log(
      `n=${n.toString().padStart(2)}: lp=${okCount}/${total} rigid=${rigidCount}/${total} class1=${class1Count}/${total} ` +
      `to=${timedOutCount}/${total} ` +
      `avg=(${(avgMembers / total).toFixed(0)}m ` +
      `${(avgStruts / total).toFixed(0)}S ${(avgCables / total).toFixed(0)}C) ` +
      `dimW=${(avgDimW / total).toFixed(1)} evts=${(avgEvents / total).toFixed(0)}`
    );
  }

  console.log('\n=== Detailed run (n=10) ===');
  const r = await searchClass1Tensegrity(10, null, 7, {
    yieldToEventLoop: false,
    timeoutMs: 10_000,
  });
  console.log(`Nodes=${r.state.nodes.length}, Members=${r.state.members.length}, Cells=${r.state.cells.length}`);
  console.log(`Struts=${r.state.members.filter(m => m.type === 'strut').length}, ` +
    `Cables=${r.state.members.filter(m => m.type === 'cable').length}, ` +
    `dim W=${dimW(r.state)}`);
  console.log(`Rigid=${r.rigid}, Class-1=${r.class1}, LP success=${r.success}, ` +
    `timedOut=${r.timedOut}, elapsed=${r.elapsedMs}ms`);
  console.log(`Equilibrium residual: ${verifyEquilibrium(r.state).toExponential(2)}`);

  console.log('\nFirst 20 events:');
  for (const ev of r.state.events.slice(0, 20)) {
    const w = (ev.dim_W_before !== undefined && ev.dim_W_after !== undefined)
      ? ` (W ${ev.dim_W_before}→${ev.dim_W_after})` : '';
    console.log(`  [${ev.kind.toUpperCase()}] ${ev.message}${w}`);
  }
}

main().catch(err => { console.error(err); });
