import React, { useState } from 'react';
import { useAppState } from '../state/context';

export function ControlPanel() {
  const { state, dispatch } = useAppState();
  const [numCells, setNumCells] = useState(5);
  const [spread, setSpread] = useState(0.4);
  const [fuseProbability, setFuseProbability] = useState(0.2);

  const { morpho } = state;
  const nNodes = morpho.graph.nodes.length;
  const nEdges = morpho.graph.edges.length;
  const nCells = morpho.cells.length;
  const nStruts = morpho.graph.edges.filter(e => e.type === 'strut').length;
  const nCables = morpho.graph.edges.filter(e => e.type === 'cable').length;
  const stressDim = morpho.stressBasis.length;

  return (
    <div className="control-panel">
      <h3>Tensegrity Morphogenesis</h3>

      <p className="hint-text">
        K₅ cellular morphogenesis (Aloui et al. 2019).
        Each cell is a complete graph on 5 nodes with
        analytically guaranteed self-stress.
      </p>

      <div className="control-section">
        <div className="param-group">
          <label>Cells<span className="param-value">{numCells}</span></label>
          <input type="range" min={1} max={20} step={1} value={numCells}
            onChange={e => setNumCells(parseInt(e.target.value))} />
        </div>

        <div className="param-group">
          <label>Spread<span className="param-value">{spread.toFixed(1)}</span></label>
          <input type="range" min={0} max={1} step={0.1} value={spread}
            onChange={e => setSpread(parseFloat(e.target.value))} />
        </div>

        <div className="param-group">
          <label>Fusion<span className="param-value">{(fuseProbability * 100).toFixed(0)}%</span></label>
          <input type="range" min={0} max={0.5} step={0.05} value={fuseProbability}
            onChange={e => setFuseProbability(parseFloat(e.target.value))} />
        </div>

        <button className="generate-btn"
          onClick={() => dispatch({ type: 'GENERATE', numCells, spread, fuseProbability })}>
          Generate
        </button>

        <button className="clear-btn"
          onClick={() => dispatch({ type: 'CLEAR' })}>
          Clear
        </button>
      </div>

      {nCells > 0 && (
        <div className="stats-section">
          <h4>Structure</h4>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Cells</span><span className="stat-value">{nCells}</span></div>
            <div className="stat"><span className="stat-label">Nodes</span><span className="stat-value">{nNodes}</span></div>
            <div className="stat"><span className="stat-label">Struts</span><span className="stat-value strut-color">{nStruts}</span></div>
            <div className="stat"><span className="stat-label">Cables</span><span className="stat-value cable-color">{nCables}</span></div>
            <div className="stat"><span className="stat-label">Self-stress dim</span><span className="stat-value">{stressDim}</span></div>
          </div>

          <div className="tensegrity-status valid" style={{ marginTop: 8 }}>
            <span className="status-icon">✓</span>
            <span>Self-stressed tensegrity ({stressDim} stress state{stressDim !== 1 ? 's' : ''})</span>
          </div>
        </div>
      )}

      <div className="info-section">
        <h4>Operations</h4>
        <div className="fg-rules-info">
          <div className="fg-rule"><b>SEED</b> — K₅ cell (5 nodes, 10 edges)</div>
          <div className="fg-rule"><b>ADHESION</b> — attach new K₅ sharing 3 nodes</div>
          <div className="fg-rule"><b>FUSION</b> — remove shared edge (β-adjustment)</div>
        </div>
      </div>

      <div className="fg-ref">
        Aloui, Orden, Rhode-Barbarigos (2019)
      </div>
    </div>
  );
}
