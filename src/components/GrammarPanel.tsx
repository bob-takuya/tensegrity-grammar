import React, { useState } from 'react';
import { useAppState } from '../state/context';

export function GrammarPanel() {
  const { state, dispatch } = useAppState();
  const [numCells, setNumCells] = useState(5);

  return (
    <div className="grammar-panel">
      <h3>Tensegrity Generation</h3>

      <p className="hint-text">
        Cellular morphogenesis: stack prism cells upward.
        Each cell adds 3 plates + 6 cables. Self-stress is
        guaranteed by force density form-finding.
      </p>

      <div className="fg-rules-info">
        <div className="fg-rule"><b>SEED</b> — initial 3-strut tensegrity prism</div>
        <div className="fg-rule"><b>ADHESION</b> — stack a new prism cell on the top face</div>
        <div className="fg-rule"><b>FUSION</b> — remove redundant cables</div>
      </div>

      <div className="prop-group" style={{ margin: '8px 0' }}>
        <label>Plate Thickness (mm)</label>
        <input
          type="number"
          step="0.5"
          min="0.5"
          value={state.globalPlateThickness}
          onChange={(e) =>
            dispatch({
              type: 'SET_GLOBAL_PLATE_THICKNESS',
              thickness: Math.max(0.5, parseFloat(e.target.value) || 3),
            })
          }
        />
      </div>

      <div className="fg-auto-explore">
        <div className="explore-row">
          <input
            type="number"
            className="step-input"
            min={1}
            max={20}
            value={numCells}
            onChange={(e) => setNumCells(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
          />
          <span className="step-label">cells</span>
          <button
            className="explore-btn explore-go"
            onClick={() => dispatch({ type: 'FORCE_GRAMMAR_AUTO_EXPLORE', steps: numCells })}
          >
            Generate
          </button>
        </div>
      </div>

      {/* Status */}
      {(() => {
        const plates = state.diagram.edges.filter(e => e.elementType === 'compression').length;
        const cables = state.diagram.edges.filter(e => e.elementType === 'tension').length;
        if (plates === 0 && cables === 0) return null;

        const pEnds = new Set<string>();
        for (const e of state.diagram.edges) if (e.elementType === 'compression') { pEnds.add(e.source); pEnds.add(e.target); }

        // Tension connectivity
        const adj = new Map<string, string[]>();
        for (const e of state.diagram.edges) {
          if (e.elementType !== 'tension') continue;
          if (!adj.has(e.source)) adj.set(e.source, []);
          if (!adj.has(e.target)) adj.set(e.target, []);
          adj.get(e.source)!.push(e.target);
          adj.get(e.target)!.push(e.source);
        }
        let connected = true;
        if (pEnds.size > 0) {
          const visited = new Set<string>();
          const q = [[...pEnds][0]]; visited.add(q[0]);
          while (q.length > 0) { const c = q.shift()!; for (const nb of (adj.get(c) || [])) if (!visited.has(nb)) { visited.add(nb); q.push(nb); } }
          for (const pe of pEnds) if (!visited.has(pe)) { connected = false; break; }
        }

        let maxComp = 0;
        for (const n of state.diagram.nodes) {
          const cd = state.diagram.edges.filter(e => e.elementType === 'compression' && (e.source === n.id || e.target === n.id)).length;
          maxComp = Math.max(maxComp, cd);
        }

        const valid = connected && plates >= 3;
        return (
          <div className={`tensegrity-status ${valid ? 'valid' : 'invalid'}`} style={{ marginTop: 8 }}>
            <span className="status-icon">{valid ? '✓' : '✗'}</span>
            <span>
              {plates} plates, {cables} cables
              {valid ? ` — Class-${maxComp} tensegrity` : ''}
            </span>
          </div>
        );
      })()}

      <div className="fg-ref" style={{ marginTop: 8 }}>
        Ref: Aloui, Orden, Rhode-Barbarigos (2019)
      </div>
    </div>
  );
}
