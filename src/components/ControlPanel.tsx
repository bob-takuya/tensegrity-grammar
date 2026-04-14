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
  const { state, runSearch, stopSearch, dispatch } = useAppState();
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

  /* ── Known tensegrity configurations (presets) ───────────────
   *
   * Each preset is just a point cloud — NO pre-computed
   * structure, NO hand-crafted cover or fusion sequence. The
   * search algorithm is expected to discover a valid Class-k
   * tensegrity on these configurations unassisted. This lets the
   * user verify end-to-end: "if I give the algorithm the Triplex
   * / Icosahedron / Quadruplex points, does it actually find a
   * Class-1 tensegrity the way the paper describes?".
   *
   * Coordinates are in a unit-scale coordinate frame. Bottom
   * layers sit at z = 0, top layers at z = h. Twist angles
   * match the canonical Aloui §5 values:
   *   n-plex twist = 180° − (180° × (n−2)/n)  (geodesic prism)
   * For regular n = 3, 4, 5, 6 this gives 60°, 45°, 36°, 30°.
   *
   * The icosahedron preset uses the standard 12-vertex
   * coordinates (φ-scaled octahedron) — a classical Class-1
   * tensegrity with 6 struts connecting antipodal pairs.
   */
  interface Preset {
    id: string;
    name: string;
    description: string;
    points: Vec3[];
  }

  const makeNPlex = (n: number, r: number, h: number): Vec3[] => {
    const twist = Math.PI / n;
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push([r * Math.cos(a), r * Math.sin(a), 0]);
    }
    for (let i = 0; i < n; i++) {
      const a = twist + (2 * Math.PI * i) / n;
      pts.push([r * Math.cos(a), r * Math.sin(a), h]);
    }
    return pts;
  };

  const icosahedronPoints = (): Vec3[] => {
    // Regular icosahedron — 12 vertices at the 4-cyclic positions
    // (0, ±1, ±φ), (±1, ±φ, 0), (±φ, 0, ±1) with φ = (1 + √5)/2.
    // Normalised so |v| = 1 for every vertex.
    const phi = (1 + Math.sqrt(5)) / 2;
    const n = Math.sqrt(1 + phi * phi);
    const a = 1 / n;
    const b = phi / n;
    return [
      [ 0, -a, -b], [ 0, -a,  b], [ 0,  a, -b], [ 0,  a,  b],
      [-a, -b,  0], [-a,  b,  0], [ a, -b,  0], [ a,  b,  0],
      [-b,  0, -a], [-b,  0,  a], [ b,  0, -a], [ b,  0,  a],
    ];
  };

  const presets: Preset[] = [
    {
      id: 'triplex',
      name: 'Triplex (n=6)',
      description: '3-strut twisted triangular prism (Aloui §5.1)',
      points: makeNPlex(3, 1.0, 1.2),
    },
    {
      id: 'quadruplex',
      name: 'Quadruplex (n=8)',
      description: '4-strut twisted square prism (45° twist)',
      points: makeNPlex(4, 1.0, 1.3),
    },
    {
      id: 'pentaplex',
      name: 'Pentaplex (n=10)',
      description: '5-strut twisted pentagonal prism (36° twist)',
      points: makeNPlex(5, 1.0, 1.4),
    },
    {
      id: 'hexaplex',
      name: 'Hexaplex (n=12)',
      description: '6-strut twisted hexagonal prism (30° twist)',
      points: makeNPlex(6, 1.0, 1.5),
    },
    {
      id: 'icosahedron',
      name: 'Icosahedron (n=12)',
      description: '12-vertex regular icosahedron (6 antipodal struts)',
      points: icosahedronPoints(),
    },
  ];

  const formatPreset = (preset: Preset): string => {
    const fmt = (v: number) => v.toFixed(4);
    return [
      `# ${preset.name} — ${preset.description}`,
      `# ${preset.points.length} points, generated by the client`,
      ...preset.points.map(p => `${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`),
    ].join('\n');
  };

  /**
   * Load a preset's points into the custom textarea and fire
   * a normal `runSearch` with those points as the input. The
   * search then runs through the same K₅ cover → Phase 3
   * pipeline as any random-point run — no hand-crafted cover,
   * no hand-crafted fusion sequence. This is the UX the user
   * asked for: "just input the points, let the algorithm find
   * the structure on its own".
   */
  const loadPreset = (id: string) => {
    const p = presets.find(x => x.id === id);
    if (!p) return;
    setCustomText(formatPreset(p));
    setCustomMode(true);
    setN(p.points.length);
    setSeed('');
    runSearch({
      n: p.points.length,
      points: p.points,
      seed: undefined,
      timeoutMs: Math.max(100, Math.round(timeoutSec * 1000)),
    });
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
          <label>Known tensegrity preset</label>
          <select
            onChange={e => {
              const v = e.target.value;
              if (v) loadPreset(v);
              // Reset the dropdown so the user can re-trigger
              // the same preset without first picking something
              // else.
              e.target.value = '';
            }}
            disabled={isRunning}
            style={{
              width: '100%',
              padding: 6,
              border: '1px solid #ddd',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'inherit',
              background: '#eef3fa',
              color: '#1565c0',
              cursor: isRunning ? 'not-allowed' : 'pointer',
            }}
            value=""
          >
            <option value="" disabled>— select a preset —</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="param-hint">
            Loads a known tensegrity point configuration and runs
            the normal search pipeline on it. The algorithm is
            expected to discover the structure unaided — no
            hand-crafted cover or fusion sequence is injected.
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
            } else if (search.bestClassK > 0 && search.allConnected) {
              // Spec v6: expose the search driver's best Class-k
              // snapshot — a settled-but-non-success run that at
              // least produced a fully-connected Class-k > 1
              // structure is still useful to visualise.
              icon = '◈';
              label = `Class-${search.bestClassK} (best of search)`;
            } else {
              icon = '✗';
              const reasons: string[] = [];
              if (!search.allConnected) reasons.push('unconnected nodes');
              if (!search.lpSuccess) reasons.push('LP failed');
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
            <>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 10,
                  fontFamily: 'monospace',
                  color: '#666',
                }}
              >
                rigid={String(search.rigid)} · class1={String(search.class1)} ·
                lp={String(search.lpSuccess)} ·
                connected={String(search.allConnected)}
              </div>
              {search.bestResultNote && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 10,
                    color: '#888',
                    lineHeight: 1.4,
                  }}
                >
                  {search.bestResultNote}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="fg-ref">Aloui, Orden, Rhode-Barbarigos (2019)</div>
    </div>
  );
}
