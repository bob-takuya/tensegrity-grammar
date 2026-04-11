import React, { useState } from 'react';
import { useAppState } from '../state/context';

export function ControlPanel() {
  const { state, dispatch } = useAppState();
  const [numCells, setNumCells] = useState(5);
  const [spread, setSpread] = useState(0.4);
  const [fuseProbability, setFuseProbability] = useState(0.2);
  const [maxCompDeg, setMaxCompDeg] = useState(1); // 1 = Class-1

  const { morpho } = state;
  const nNodes = morpho.graph.nodes.length;
  const nEdges = morpho.graph.edges.length;
  const nCells = morpho.cells.length;
  const nStruts = morpho.graph.edges.filter(e => e.type === 'strut').length;
  const nCables = morpho.graph.edges.filter(e => e.type === 'cable').length;
  const stressDim = morpho.stressBasis.length;
  const actualMaxComp = nNodes > 0 ? Math.max(...morpho.graph.nodes.map(n =>
    morpho.graph.edges.filter(e => e.type === 'strut' && (e.n[0] === n.id || e.n[1] === n.id)).length
  )) : 0;

  return (
    <div className="control-panel">
      <h3>Tensegrity Morphogenesis</h3>

      <p className="hint-text">
        K₅ cellular morphogenesis (Aloui et al. 2019).
        Each cell = complete graph on 5 nodes with
        guaranteed self-stress.
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
          <label>Fusion rate<span className="param-value">{(fuseProbability * 100).toFixed(0)}%</span></label>
          <input type="range" min={0} max={0.5} step={0.05} value={fuseProbability}
            onChange={e => setFuseProbability(parseFloat(e.target.value))} />
        </div>

        <div className="param-group">
          <label>Max struts/node<span className="param-value">{maxCompDeg === 99 ? '∞' : maxCompDeg}</span></label>
          <input type="range" min={1} max={6} step={1} value={Math.min(maxCompDeg, 6)}
            onChange={e => setMaxCompDeg(parseInt(e.target.value))} />
          <div className="param-hint">
            {maxCompDeg === 1 ? 'Class-1 (struts isolated)' :
             maxCompDeg === 2 ? 'Class-2 (pairs allowed)' :
             `Class-${maxCompDeg}`}
          </div>
        </div>

        <button className="generate-btn"
          onClick={() => dispatch({ type: 'GENERATE', numCells, spread, fuseProbability, maxCompDeg })}>
          Generate
        </button>

        {nCells > 0 && (
          <button className="clear-btn" onClick={() => dispatch({ type: 'CLEAR' })}>
            Clear
          </button>
        )}
      </div>

      {nCells > 0 && (
        <div className="stats-section">
          <h4>Structure</h4>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Cells</span><span className="stat-value">{nCells}</span></div>
            <div className="stat"><span className="stat-label">Nodes</span><span className="stat-value">{nNodes}</span></div>
            <div className="stat"><span className="stat-label">Struts</span><span className="stat-value strut-color">{nStruts}</span></div>
            <div className="stat"><span className="stat-label">Cables</span><span className="stat-value cable-color">{nCables}</span></div>
            <div className="stat"><span className="stat-label">Stress dim</span><span className="stat-value">{stressDim}</span></div>
            <div className="stat"><span className="stat-label">Class</span><span className="stat-value">{actualMaxComp}</span></div>
          </div>

          <div className="tensegrity-status valid" style={{ marginTop: 8 }}>
            <span className="status-icon">✓</span>
            <span>{stressDim} self-stress state{stressDim !== 1 ? 's' : ''}</span>
          </div>
        </div>
      )}

      <div className="info-section">
        <h4>Operations</h4>
        <div className="fg-rules-info">
          <div className="fg-rule"><b>SEED</b> — K₅ cell (5 nodes, 10 edges, 4 struts + 6 cables)</div>
          <div className="fg-rule"><b>ADHESION</b> — attach K₅ cell sharing 3 nodes</div>
          <div className="fg-rule"><b>1-EDGE FUSION</b> — remove edge (β-adjustment, always works)</div>
          <div className="fg-rule"><b>2-EDGE FUSION</b> — plane or quadric constraint</div>
        </div>
      </div>

      {nCells > 0 && state.selectedEdgeIds.length > 0 && (
        <div className="selection-section">
          <h4>Selected</h4>
          <p className="hint-text">{state.selectedEdgeIds.length} edge(s) selected</p>
          {state.selectedEdgeIds.length === 1 && (
            <button className="fuse-btn"
              onClick={() => dispatch({ type: 'FUSE_EDGE', edgeId: state.selectedEdgeIds[0] })}>
              Fuse (remove) selected edge
            </button>
          )}
          {state.selectedEdgeIds.length === 2 && (
            <button className="fuse-btn"
              onClick={() => dispatch({ type: 'FUSE_TWO_EDGES', edgeId1: state.selectedEdgeIds[0], edgeId2: state.selectedEdgeIds[1] })}>
              Fuse 2 edges (constraint solve)
            </button>
          )}
        </div>
      )}

      <div className="fg-ref">Aloui, Orden, Rhode-Barbarigos (2019)</div>
    </div>
  );
}
