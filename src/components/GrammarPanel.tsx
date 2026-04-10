import React from 'react';

/**
 * Grammar Rule Panel — Phase 2 placeholder.
 * Will contain grammar rule definition, matching, and application UI.
 */
export function GrammarPanel() {
  return (
    <div className="grammar-panel">
      <h3>Grammar Rules</h3>
      <p className="hint-text">
        Shape grammar engine coming in Phase 2.
      </p>
      <div className="grammar-preview">
        <div className="rule-card">
          <div className="rule-header">Subdivision Rule</div>
          <div className="rule-body">
            <span className="rule-lhs">△</span>
            <span className="rule-arrow">→</span>
            <span className="rule-rhs">△△△</span>
          </div>
          <span className="rule-status">Preview</span>
        </div>
        <div className="rule-card">
          <div className="rule-header">Branching Rule</div>
          <div className="rule-body">
            <span className="rule-lhs">—●—</span>
            <span className="rule-arrow">→</span>
            <span className="rule-rhs">—●⟨</span>
          </div>
          <span className="rule-status">Preview</span>
        </div>
        <div className="rule-card">
          <div className="rule-header">Extension Rule</div>
          <div className="rule-body">
            <span className="rule-lhs">●</span>
            <span className="rule-arrow">→</span>
            <span className="rule-rhs">●—●</span>
          </div>
          <span className="rule-status">Preview</span>
        </div>
      </div>
    </div>
  );
}
