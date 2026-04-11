import React from 'react';
import { useAppState } from '../state/context';
import { presetRules } from '../grammar/presets';

export function GrammarPanel() {
  const { state, dispatch } = useAppState();
  const { selectedRuleId, ruleMatches, ruleParams, highlightedMatchIndex } = state;

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

      {/* Auto-explore */}
      <div className="auto-explore">
        <h4>Auto Explore</h4>
        <p className="hint-text">
          Stochastically apply random rules to explore design space.
        </p>
        <div className="explore-buttons">
          <button
            className="explore-btn"
            onClick={() => dispatch({ type: 'AUTO_EXPLORE', steps: 1 })}
          >
            +1 step
          </button>
          <button
            className="explore-btn"
            onClick={() => dispatch({ type: 'AUTO_EXPLORE', steps: 3 })}
          >
            +3 steps
          </button>
          <button
            className="explore-btn"
            onClick={() => dispatch({ type: 'AUTO_EXPLORE', steps: 5 })}
          >
            +5 steps
          </button>
        </div>
      </div>

      {/* ─── Force-Based Grammar (Mirtsopoulos & Fivet) ────────── */}
      <div className="force-grammar-section">
        <h4>Force-Based Grammar</h4>
        <p className="hint-text">
          Build structures where equilibrium is guaranteed by construction.
          Interim forces are routed through members to supports.
        </p>
        {!state.forceGrammar.active ? (
          <button
            className="explore-btn force-grammar-start"
            onClick={() => dispatch({ type: 'START_FORCE_GRAMMAR' })}
          >
            Start Force Grammar
          </button>
        ) : (
          <>
            <button
              className="explore-btn"
              onClick={() => dispatch({ type: 'STOP_FORCE_GRAMMAR' })}
            >
              Stop
            </button>

            {state.forceGrammar.isComplete ? (
              <div className="fg-complete">
                Structure complete — all forces resolved.
              </div>
            ) : (
              <div className="fg-forces">
                <div className="fg-instructions">
                  1. Select an interim force below<br/>
                  2. Click on the canvas to place a new node<br/>
                  &nbsp;&nbsp;&nbsp;(on the line of action = optimal)<br/>
                  3. Or click an existing node to connect
                </div>
                {state.forceGrammar.interimForces.map((f) => {
                  const fMag = Math.sqrt(f.fx * f.fx + f.fy * f.fy);
                  const isSelected = state.forceGrammar.selectedForceId === f.id;
                  const node = state.diagram.nodes.find((n) => n.id === f.nodeId);
                  return (
                    <div
                      key={f.id}
                      className={`fg-force-item ${isSelected ? 'selected' : ''}`}
                      onClick={() =>
                        dispatch({
                          type: 'SELECT_INTERIM_FORCE',
                          forceId: isSelected ? null : f.id,
                        })
                      }
                    >
                      <span className="fg-force-node">
                        ({node?.x.toFixed(1)}, {node?.y.toFixed(1)})
                      </span>
                      <span className="fg-force-vec">
                        ({f.fx.toFixed(2)}, {f.fy.toFixed(2)})
                      </span>
                      <span className="fg-force-mag">{fMag.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        <div className="fg-ref">
          Ref: Mirtsopoulos &amp; Fivet (archiDOCT 2020)
        </div>
      </div>
    </div>
  );
}
