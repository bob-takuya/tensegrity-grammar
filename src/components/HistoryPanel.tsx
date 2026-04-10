import React from 'react';
import { useAppState } from '../state/context';
import { getTreeLayout } from '../grammar/history';

export function HistoryPanel() {
  const { state, dispatch } = useAppState();
  const { historyTree } = state;

  if (!historyTree) {
    return (
      <div className="history-panel">
        <h3>Derivation History</h3>
        <p className="hint-text">Apply grammar rules to build a derivation tree.</p>
      </div>
    );
  }

  const layout = getTreeLayout(historyTree);
  const maxDepth = Math.max(0, ...layout.map((l) => l.depth));

  return (
    <div className="history-panel">
      <h3>Derivation History</h3>
      <div className="history-tree">
        {layout.map(({ node, depth }) => {
          const isCurrent = node.id === historyTree.currentId;
          const isRoot = node.parentId === null;

          return (
            <div
              key={node.id}
              className={`history-node ${isCurrent ? 'current' : ''}`}
              style={{ paddingLeft: depth * 16 + 4 }}
              onClick={() => dispatch({ type: 'NAVIGATE_HISTORY', historyId: node.id })}
            >
              <span className="history-dot" />
              <div className="history-info">
                {isRoot ? (
                  <span className="history-label">Initial</span>
                ) : node.ruleApplied ? (
                  <>
                    <span className="history-rule-name">{node.ruleApplied.ruleName}</span>
                    <span className="history-match-label">{node.ruleApplied.matchLabel}</span>
                  </>
                ) : (
                  <span className="history-label">Step</span>
                )}
              </div>
              <span className="history-meta">
                {node.diagram.nodes.length}n {node.diagram.edges.length}e
              </span>
            </div>
          );
        })}
      </div>
      {maxDepth > 0 && (
        <div className="history-stats">
          Depth: {maxDepth} | Nodes: {historyTree.nodes.size}
        </div>
      )}
    </div>
  );
}
