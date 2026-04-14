import React, { useState } from 'react';
import { useAppState } from '../state/context';
import type { Vec3 } from '../morphogenesis/types';

/**
 * Control panel — simplified to the minimum.
 *
 * Inputs the user can tweak:
 *   - `n`         number of points
 *   - `timeoutMs` wall-clock search budget (drives Phase 3 termination)
 *   - optional custom positions and seed
 *
 * The search runs asynchronously via `runSearch` so the 3D viewer
 * and the event log update in real time while it progresses. A
 * Stop button aborts the current run via AbortController.
 */
export function ControlPanel() {
  const { state, runSearch, runTriplex, stopSearch, dispatch } = useAppState();
  const [n, setN] = useState(12);
  const [timeoutSec, setTimeoutSec] = useState(10);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const [seed, setSeed] = useState<string>('');

  const { morpho, search } = state;
  const nNodes = morpho.nodes.length;
  const nMembers = morpho.members.length;
  const nCells = morpho.cells.length;
  const nStruts = morpho.members.filter(m => m.type === 'strut').length;
  const nCables = morpho.members.filter(m => m.type === 'cable').length;
  const nCandidates = morpho.members.filter(m => m.type === 'candidate').length;
  const stressDim = morpho.selfStressStates.length;
  const nEvents = morpho.events.length;

  const isRunning = search.status === 'running';

  // Max struts incident to a single node — still useful during live
  // Phase 2/3 runs where the final validation flags aren't yet set.
  const actualMaxComp = nNodes > 0 ? Math.max(0, ...morpho.nodes.map(n =>
    morpho.members.filter(m =>
      m.type === 'strut' && (m.node_a === n.node_id || m.node_b === n.node_id)
    ).length
  )) : 0;

  const parseCustom = (): Vec3[] | null => {
    if (!customMode || !customText.trim()) return null;
    const out: Vec3[] = [];
    const lines = customText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/[\s,]+/).map(Number);
      if (parts.length >= 3 && parts.every(p => Number.isFinite(p))) {
        out.push([parts[0], parts[1], parts[2]]);
      }
    }
    return out.length >= 5 ? out : null;
  };

  const handleSearch = () => {
    const points = parseCustom();
    const target = points ? points.length : n;
    const parsedSeed = seed.trim() === '' ? undefined : Number(seed);
    runSearch({
      n: target,
      points,
      seed: parsedSeed,
      timeoutMs: Math.max(100, Math.round(timeoutSec * 1000)),
    });
  };

  // Progress bar: percentage of the timeout budget consumed so far.
  const progressPct = search.timeoutMs > 0
    ? Math.min(100, Math.max(0, (search.elapsedMs / search.timeoutMs) * 100))
    : 0;

  const statusLabel = {
    idle: '',
    running: `running · ${search.phase}`,
    done: 'done',
    timeout: 'timed out',
    aborted: 'aborted',
  }[search.status];

  /**
   * Return the 6 canonical Triplex points. Bottom triangle
   * {A, B, C} sits at z = 0 on angles 0°, 120°, 240°; top triangle
   * {D, E, F} at z = h on angles 30°, 150°, 270° (a 30° / π/6 twist
   * from the bottom).
   */
  const triplexPoints = (): Vec3[] => {
    const r = 1.0;
    const h = 1.2;
    const twist = Math.PI / 6;
    return [
      [r * Math.cos(0),                     r * Math.sin(0),                     0],
      [r * Math.cos((2 * Math.PI) / 3),     r * Math.sin((2 * Math.PI) / 3),     0],
      [r * Math.cos((4 * Math.PI) / 3),     r * Math.sin((4 * Math.PI) / 3),     0],
      [r * Math.cos(twist),                 r * Math.sin(twist),                 h],
      [r * Math.cos(twist + (2 * Math.PI) / 3), r * Math.sin(twist + (2 * Math.PI) / 3), h],
      [r * Math.cos(twist + (4 * Math.PI) / 3), r * Math.sin(twist + (4 * Math.PI) / 3), h],
    ];
  };

  /**
   * Button handler: run the hand-crafted Triplex construction (seed
   * K₅ → adhere K₅ {BCDEF} → fuse BD → fuse CE → validate) on the
   * 6 preset points. Bypasses the greedy search because the specific
   * fusion sequence Aloui §5 requires is not something greedy LP
   * enforcement can discover on its own — feeding random Triplex
   * points through searchClass1Tensegrity consistently produces
   * "LP failed, no struts", hence this dedicated entry point.
   *
   * We also populate the custom textarea with the same coordinates
   * so the user can inspect them and switch to the normal search
   * afterwards if they want to compare.
   */
  const loadTriplexPreset = () => {
    const pts = triplexPoints();
    const fmt = (v: number) => v.toFixed(4);
    const lines = [
      '# Triplex canonical configuration (Aloui et al. §5)',
      '# Bottom triangle  A, B, C at z=0, angles 0° 120° 240°',
      ...pts.slice(0, 3).map(p => `${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`),
      '# Top triangle     D, E, F at z=h, twisted by 30°',
      ...pts.slice(3).map(p => `${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`),
    ];
    setCustomText(lines.join('\n'));
    setCustomMode(true);
    setN(6);
    setSeed('');
    // Fire the manual Triplex construction immediately so the
    // viewer shows the correct result (3 struts A-E, C-D, B-F,
    // 9 cables) without the user having to also click Search.
    runTriplex(pts, Math.max(100, Math.round(timeoutSec * 1000)));
  };

  return (
    <div className="control-panel">
      <h3>Class-1 Search</h3>

      <p className="hint-text">
        Search for a Class-1 tensegrity on <b>n</b> points via K₅ cellular
        morphogenesis (Aloui et al. 2019) + LP + strategic fusion.
      </p>

      <div className="control-section">
        <div className="param-group">
          <label>Number of points (n)<span className="param-value">{n}</span></label>
          <input type="range" min={5} max={40} step={1} value={n}
            onChange={e => setN(parseInt(e.target.value))}
            disabled={customMode || isRunning} />
        </div>

        <div className="param-group">
          <label>
            Timeout (s)
            <span className="param-value">{timeoutSec.toFixed(1)}</span>
          </label>
          <input type="range" min={0.5} max={60} step={0.5} value={timeoutSec}
            onChange={e => setTimeoutSec(parseFloat(e.target.value))}
            disabled={isRunning} />
          <input
            type="number"
            min={0.1}
            max={600}
            step={0.1}
            value={timeoutSec}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) setTimeoutSec(v);
            }}
            disabled={isRunning}
            style={{
              width: '100%',
              marginTop: 4,
              padding: 4,
              border: '1px solid #ddd',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
            }}
          />
          <div className="param-hint">
            Phase 3 stops at this wall-clock budget and returns the
            best structure it reached.
          </div>
        </div>

        <div className="param-group">
          <label style={{ fontSize: 11, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={customMode}
              onChange={e => setCustomMode(e.target.checked)}
              disabled={isRunning}
              style={{ marginRight: 6 }}
            />
            Custom point positions
          </label>
        </div>

        <div className="param-group">
          <button
            type="button"
            onClick={loadTriplexPreset}
            disabled={isRunning}
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 11,
              fontFamily: 'inherit',
              background: '#eef3fa',
              color: '#1565c0',
              border: '1px solid #bcd2ea',
              borderRadius: 4,
              cursor: isRunning ? 'not-allowed' : 'pointer',
            }}
          >
            Load Triplex preset (6 points)
          </button>
          <div className="param-hint">
            Loads the canonical 6-node Triplex configuration: two
            triangles of radius 1 separated by height 1.2 with a 30°
            twist. Expected result is 3 struts (A–E, C–D, B–F).
          </div>
        </div>

        {customMode && (
          <div className="param-group">
            <textarea
              value={customText}
              onChange={e => setCustomText(e.target.value)}
              disabled={isRunning}
              placeholder="one point per line: x y z"
              style={{
                width: '100%', minHeight: 80, fontFamily: 'monospace',
                fontSize: 11, padding: 6, border: '1px solid #ddd',
                borderRadius: 4, resize: 'vertical',
              }}
            />
            <div className="param-hint">
              {parseCustom() ? `${parseCustom()!.length} points parsed` : 'Need ≥ 5 valid (x y z) rows'}
            </div>
          </div>
        )}

        <div className="param-group">
          <label>Random seed (optional)</label>
          <input
            type="text"
            value={seed}
            onChange={e => setSeed(e.target.value)}
            disabled={isRunning}
            placeholder="empty = random"
            style={{
              width: '100%', padding: 4, border: '1px solid #ddd',
              borderRadius: 4, fontSize: 11, fontFamily: 'monospace',
            }}
          />
        </div>

        {isRunning ? (
          <button className="clear-btn" onClick={stopSearch}>
            Stop Search
          </button>
        ) : (
          <button className="generate-btn" onClick={handleSearch}>
            Search Class-1 Tensegrity
          </button>
        )}

        {nCells > 0 && !isRunning && (
          <button className="clear-btn" onClick={() => dispatch({ type: 'CLEAR' })}>
            Clear
          </button>
        )}
      </div>

      {(isRunning || search.status !== 'idle') && (
        <div className="stats-section">
          <h4>Search progress</h4>
          <div
            style={{
              fontSize: 11,
              color: search.status === 'timeout' ? '#b71c1c' :
                     search.status === 'running' ? '#1565c0' : '#2e7d32',
              marginBottom: 6,
              fontFamily: 'monospace',
            }}
          >
            {statusLabel}
          </div>
          <div
            style={{
              width: '100%',
              height: 6,
              background: '#e0e0e0',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                background: search.status === 'timeout' ? '#b71c1c' :
                            search.status === 'running' ? '#1565c0' : '#2e7d32',
                transition: 'width 60ms linear',
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 10,
              color: '#666',
              marginTop: 4,
              fontFamily: 'monospace',
            }}
          >
            <span>tick {search.tick}</span>
            <span>{(search.elapsedMs / 1000).toFixed(2)}s / {(search.timeoutMs / 1000).toFixed(1)}s</span>
          </div>
        </div>
      )}

      {nCells > 0 && (
        <div className="stats-section">
          <h4>Tables</h4>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">NODE</span><span className="stat-value">{nNodes}</span></div>
            <div className="stat"><span className="stat-label">MEMBER</span><span className="stat-value">{nMembers}</span></div>
            <div className="stat"><span className="stat-label">CELL</span><span className="stat-value">{nCells}</span></div>
            <div className="stat"><span className="stat-label">STEP</span><span className="stat-value">{morpho.morphogenesisSteps.length}</span></div>
            <div className="stat"><span className="stat-label">STATE</span><span className="stat-value">{stressDim}</span></div>
            <div className="stat"><span className="stat-label">EVENT</span><span className="stat-value">{nEvents}</span></div>
          </div>

          <h4>Structure</h4>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Struts</span><span className="stat-value strut-color">{nStruts}</span></div>
            <div className="stat"><span className="stat-label">Cables</span><span className="stat-value cable-color">{nCables}</span></div>
            <div className="stat"><span className="stat-label">Candidate</span><span className="stat-value">{nCandidates}</span></div>
            <div className="stat"><span className="stat-label">dim W</span><span className="stat-value">{stressDim}</span></div>
            <div className="stat"><span className="stat-label">Max strut/v</span><span className="stat-value">{actualMaxComp}</span></div>
          </div>

          {(() => {
            // Final label uses the validation flags recorded at
            // SEARCH_DONE — not recomputed from live member types.
            // During a run we still show the live max-strut/vertex
            // tally so the user can watch Phase 2 sketch out a
            // pre-LP Class-k approximation.
            const settled = search.status === 'done'
              || search.status === 'timeout'
              || search.status === 'aborted';
            const valid =
              settled && search.rigid && search.class1 && search.lpSuccess;

            let label: string;
            let icon: string;
            if (isRunning) {
              icon = '…';
              label = nStruts === 0
                ? 'searching…'
                : `Class-${actualMaxComp} (search in progress)`;
            } else if (!settled) {
              icon = '…';
              label = 'idle';
            } else if (valid) {
              icon = '✓';
              label = 'Class-1 tensegrity found';
            } else {
              icon = '✗';
              const reasons: string[] = [];
              if (!search.lpSuccess) reasons.push('LP failed');
              // Only label a Class-N violation when there ARE struts
              // but they share a node. "no struts" handles the empty
              // case below, and we don't want to print "Class-1" as a
              // failure reason (the old Math.max(1, 0) produced that
              // misleading string for zero-strut structures).
              if (!search.class1 && nStruts > 0 && actualMaxComp >= 2) {
                reasons.push(`Class-${actualMaxComp}`);
              }
              if (!search.rigid) reasons.push('not rigid');
              if (nStruts === 0) reasons.push('no struts');
              label = reasons.length > 0
                ? `Not Class-1 (${reasons.join(', ')})`
                : 'Not Class-1';
            }

            return (
              <div
                className={`tensegrity-status ${valid ? 'valid' : 'invalid'}`}
                style={{ marginTop: 8 }}
              >
                <span className="status-icon">{icon}</span>
                <span>{label}</span>
              </div>
            );
          })()}

          {search.status !== 'idle' && search.status !== 'running' && (
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                fontFamily: 'monospace',
                color: '#666',
              }}
            >
              rigid={String(search.rigid)} · class1={String(search.class1)} ·
              lp={String(search.lpSuccess)}
            </div>
          )}
        </div>
      )}

      <div className="fg-ref">Aloui, Orden, Rhode-Barbarigos (2019)</div>
    </div>
  );
}
