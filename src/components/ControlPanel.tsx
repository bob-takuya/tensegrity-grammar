import React, { useState } from 'react';
import { useAppState } from '../state/context';
import type { Vec3 } from '../morphogenesis/types';

/**
 * Control panel — simplified to the minimum.
 *
 * The only input the user exposes is `n` (number of points). An optional
 * textarea lets them paste custom coordinates. Everything else about the
 * search is driven by the Class-1 algorithm.
 */
export function ControlPanel() {
  const { state, dispatch } = useAppState();
  const [n, setN] = useState(12);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const [seed, setSeed] = useState<string>('');

  const { morpho } = state;
  const nNodes = morpho.nodes.length;
  const nMembers = morpho.members.length;
  const nCells = morpho.cells.length;
  const nStruts = morpho.members.filter(m => m.type === 'strut').length;
  const nCables = morpho.members.filter(m => m.type === 'cable').length;
  const stressDim = morpho.selfStressStates.length;
  const nEvents = morpho.events.length;

  const actualMaxComp = nNodes > 0 ? Math.max(...morpho.nodes.map(n =>
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
    dispatch({ type: 'SEARCH', n: target, points, seed: parsedSeed });
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
            disabled={customMode} />
        </div>

        <div className="param-group">
          <label style={{ fontSize: 11, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={customMode}
              onChange={e => setCustomMode(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Custom point positions
          </label>
        </div>

        {customMode && (
          <div className="param-group">
            <textarea
              value={customText}
              onChange={e => setCustomText(e.target.value)}
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
            placeholder="empty = random"
            style={{
              width: '100%', padding: 4, border: '1px solid #ddd',
              borderRadius: 4, fontSize: 11, fontFamily: 'monospace',
            }}
          />
        </div>

        <button className="generate-btn" onClick={handleSearch}>
          Search Class-1 Tensegrity
        </button>

        {nCells > 0 && (
          <button className="clear-btn" onClick={() => dispatch({ type: 'CLEAR' })}>
            Clear
          </button>
        )}
      </div>

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
            <div className="stat"><span className="stat-label">dim W</span><span className="stat-value">{stressDim}</span></div>
            <div className="stat"><span className="stat-label">Max strut/v</span><span className="stat-value">{actualMaxComp}</span></div>
          </div>

          <div
            className={`tensegrity-status ${actualMaxComp <= 1 && stressDim > 0 ? 'valid' : 'invalid'}`}
            style={{ marginTop: 8 }}
          >
            <span className="status-icon">{actualMaxComp <= 1 && stressDim > 0 ? '✓' : '…'}</span>
            <span>
              {actualMaxComp <= 1 && stressDim > 0
                ? 'Class-1 achieved'
                : actualMaxComp === 0
                  ? 'No struts assigned'
                  : `Class-${actualMaxComp} (search in progress)`}
            </span>
          </div>
        </div>
      )}

      <div className="fg-ref">Aloui, Orden, Rhode-Barbarigos (2019)</div>
    </div>
  );
}
