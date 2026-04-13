import React, { useState } from 'react';
import { useAppState } from '../state/context';

export function ControlPanel() {
  const { state, dispatch } = useAppState();
  const [numCells, setNumCells] = useState(5);
  const [spread, setSpread] = useState(0.4);
  const [fuseProbability, setFuseProbability] = useState(0.2);
  const [maxCompDeg, setMaxCompDeg] = useState(1); // 1 = Class-1
  const [adhesionAttempts, setAdhesionAttempts] = useState(6);

  const { morpho } = state;
  const nNodes = morpho.nodes.length;
  const nMembers = morpho.members.length;
  const nCells = morpho.cells.length;
  const nStruts = morpho.members.filter(m => m.type === 'strut').length;
  const nCables = morpho.members.filter(m => m.type === 'cable').length;
  const stressDim = morpho.selfStressStates.length;
  const actualMaxComp = nNodes > 0 ? Math.max(...morpho.nodes.map(n =>
    morpho.members.filter(m =>
      m.type === 'strut' && (m.node_a === n.node_id || m.node_b === n.node_id)
    ).length
  )) : 0;
  const nRegularCells = morpho.cells.filter(c => c.cell_type === 'regular').length;
  const nVirtualCells = morpho.cells.filter(c => c.cell_type === 'virtual').length;
  const nFusedCells  = morpho.cells.filter(c => c.cell_type === 'fused').length;
  const nSteps = morpho.morphogenesisSteps.length;

  return (
    <div className="control-panel">
      <h3>Cellular Morphogenesis</h3>

      <p className="hint-text">
        K₅ cellular morphogenesis (Aloui et al. 2019).
        Each cell = complete graph on 5 nodes with
        guaranteed 1D self-stress space.
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
          <label>K₅ adhesion attempts<span className="param-value">{adhesionAttempts}</span></label>
          <input type="range" min={0} max={20} step={1} value={adhesionAttempts}
            onChange={e => setAdhesionAttempts(parseInt(e.target.value))} />
          <div className="param-hint">Glue K₅ cells onto 3–4 existing nodes.</div>
        </div>

        <div className="param-group">
          <label>Fusion rate<span className="param-value">{(fuseProbability * 100).toFixed(0)}%</span></label>
          <input type="range" min={0} max={0.5} step={0.05} value={fuseProbability}
            onChange={e => setFuseProbability(parseFloat(e.target.value))} />
          <div className="param-hint">Remove members using nullspace freedom.</div>
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
          onClick={() => dispatch({ type: 'GENERATE', numCells, spread, fuseProbability, maxCompDeg, adhesionAttempts })}>
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
            <div className="stat"><span className="stat-label">Members</span><span className="stat-value">{nMembers}</span></div>
            <div className="stat"><span className="stat-label">Struts</span><span className="stat-value strut-color">{nStruts}</span></div>
            <div className="stat"><span className="stat-label">Cables</span><span className="stat-value cable-color">{nCables}</span></div>
            <div className="stat"><span className="stat-label">dim W</span><span className="stat-value">{stressDim}</span></div>
            <div className="stat"><span className="stat-label">Class</span><span className="stat-value">{actualMaxComp}</span></div>
            <div className="stat"><span className="stat-label">Steps</span><span className="stat-value">{nSteps}</span></div>
          </div>

          <h4>Cell types</h4>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Regular</span><span className="stat-value">{nRegularCells}</span></div>
            <div className="stat"><span className="stat-label">Virtual</span><span className="stat-value">{nVirtualCells}</span></div>
            <div className="stat"><span className="stat-label">Fused</span><span className="stat-value">{nFusedCells}</span></div>
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
          <div className="fg-rule"><b>INIT</b> — seed K₅ cell (5 nodes, 10 members)</div>
          <div className="fg-rule"><b>ADHESION</b> — new K₅ sharing 3/4 nodes, Δdim W = Δe − 3Δv</div>
          <div className="fg-rule"><b>FUSION (1-edge)</b> — linear recombination, dim W −= 1</div>
          <div className="fg-rule"><b>FUSION (2-edge)</b> — plane (Eq.15) or quadric (Eq.18)</div>
        </div>
      </div>

      {nCells > 0 && state.selectedMemberIds.length > 0 && (
        <div className="selection-section">
          <h4>Selected</h4>
          <p className="hint-text">{state.selectedMemberIds.length} member(s) selected</p>
          {state.selectedMemberIds.length === 1 && (
            <button className="fuse-btn"
              onClick={() => dispatch({ type: 'FUSE_MEMBER', memberId: state.selectedMemberIds[0] })}>
              Fuse (remove) selected member
            </button>
          )}
          {state.selectedMemberIds.length === 2 && (
            <button className="fuse-btn"
              onClick={() => dispatch({ type: 'FUSE_TWO_MEMBERS', memberId1: state.selectedMemberIds[0], memberId2: state.selectedMemberIds[1] })}>
              Fuse 2 members (constraint solve)
            </button>
          )}
        </div>
      )}

      <div className="fg-ref">Aloui, Orden, Rhode-Barbarigos (2019)</div>
    </div>
  );
}
