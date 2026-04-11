import React, { useState } from 'react';
import { useAppState } from '../state/context';
import { presetRules } from '../grammar/presets';

export function GrammarPanel() {
  const { state, dispatch } = useAppState();
  const { selectedRuleId, ruleMatches, ruleParams, highlightedMatchIndex } = state;
  const [geoSteps, setGeoSteps] = useState(3);
  const [fgSteps, setFgSteps] = useState(5);

  const selectedRule = selectedRuleId
    ? presetRules.find((r) => r.id === selectedRuleId)
    : null;

  return (
    <div className="grammar-panel">
      <h3>Grammar Rules</h3>

      {/* Rule selection */}
      <div className="rule-grid">
        {presetRules.map((rule) => (
          <button
            key={rule.id}
            className={`rule-card-btn ${selectedRuleId === rule.id ? 'active' : ''}`}
            onClick={() =>
              dispatch({
                type: 'SELECT_RULE',
                ruleId: selectedRuleId === rule.id ? null : rule.id,
              })
            }
            title={rule.description}
          >
            <span className="rule-card-icon">{rule.icon}</span>
            <span className="rule-card-name">{rule.name}</span>
          </button>
        ))}
      </div>

      {/* Selected rule details */}
      {selectedRule && (
        <div className="rule-details">
          <p className="rule-description">{selectedRule.description}</p>

          {/* Parameters */}
          {selectedRule.parameters.length > 0 && (
            <div className="rule-params">
              <h4>Parameters</h4>
              {selectedRule.parameters.map((param) => (
                <div key={param.key} className="param-group">
                  <label>
                    {param.label}
                    <span className="param-value">
                      {(ruleParams[param.key] ?? param.defaultValue).toFixed(2)}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={ruleParams[param.key] ?? param.defaultValue}
                    onChange={(e) =>
                      dispatch({
                        type: 'SET_RULE_PARAM',
                        key: param.key,
                        value: parseFloat(e.target.value),
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {/* Matches */}
          <div className="rule-matches">
            <h4>
              Matches ({ruleMatches.length})
            </h4>
            {ruleMatches.length === 0 ? (
              <p className="hint-text">No applicable locations found.</p>
            ) : (
              <div className="match-list">
                {ruleMatches.map((match, i) => (
                  <div
                    key={i}
                    className={`match-item ${highlightedMatchIndex === i ? 'highlighted' : ''}`}
                    onMouseEnter={() => dispatch({ type: 'HIGHLIGHT_MATCH', index: i })}
                    onMouseLeave={() => dispatch({ type: 'HIGHLIGHT_MATCH', index: null })}
                    onClick={() => dispatch({ type: 'APPLY_RULE', matchIndex: i })}
                  >
                    <span className="match-label">{match.label}</span>
                    <span className="match-apply">Apply</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Geometric auto-explore */}
      <div className="auto-explore">
        <h4>Geometric Auto Explore</h4>
        <p className="hint-text">
          Stochastically apply random geometric rules.
        </p>
        <div className="explore-row">
          <input
            type="number"
            className="step-input"
            min={1}
            max={50}
            value={geoSteps}
            onChange={(e) => setGeoSteps(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
          />
          <span className="step-label">steps</span>
          <button
            className="explore-btn explore-go"
            onClick={() => dispatch({ type: 'AUTO_EXPLORE', steps: geoSteps })}
          >
            Run
          </button>
        </div>
      </div>

      {/* ─── L-System Tensegrity Grammar ────────────────────────── */}
      <div className="force-grammar-section">
        <h4>L-System Tensegrity</h4>
        <p className="hint-text">
          Grow tensegrity structures organically. Each step adds one
          compression plate (面材) with minimal cables, always preserving
          the tensegrity invariant.
        </p>
        <div className="fg-rules-info">
          <div className="fg-rule"><b>SEED</b> — first plate suspended from supports</div>
          <div className="fg-rule"><b>SPROUT</b> — insert plate along an existing cable</div>
          <div className="fg-rule"><b>BRANCH</b> — attach plate branching from a node</div>
        </div>

        <div className="prop-group" style={{ margin: '6px 0' }}>
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
              value={fgSteps}
              onChange={(e) => setFgSteps(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
            />
            <span className="step-label">plates</span>
            <button
              className="explore-btn explore-go"
              onClick={() => dispatch({ type: 'FORCE_GRAMMAR_AUTO_EXPLORE', steps: fgSteps })}
            >
              Grow
            </button>
          </div>
        </div>

        {(() => {
          const plates = state.diagram.edges.filter(e => e.elementType === 'compression').length;
          const cables = state.diagram.edges.filter(e => e.elementType === 'tension').length;
          const valid = state.diagram.edges.length > 0 && state.diagram.nodes.every(n =>
            state.diagram.edges.filter(e =>
              e.elementType === 'compression' && (e.source === n.id || e.target === n.id)
            ).length <= 1
          );
          if (plates === 0 && cables === 0) return null;
          return (
            <div className={`tensegrity-status ${valid ? 'valid' : 'invalid'}`} style={{ marginTop: 8 }}>
              <span className="status-icon">{valid ? '✓' : '✗'}</span>
              <span>{plates} plates, {cables} cables{valid ? ' — valid tensegrity' : ' — invalid'}</span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
