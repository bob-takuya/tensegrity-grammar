import React from 'react';
import { useAppState } from '../state/context';
import { SupportType, ElementType } from '../types';

export function PropertiesPanel() {
  const { state, dispatch } = useAppState();
  const { diagram, selectedIds, equilibrium } = state;

  if (selectedIds.length === 0) {
    return (
      <div className="properties-panel">
        <h3>Properties</h3>
        <p className="hint-text">Select a node or edge to view its properties.</p>
        <div className="help-section">
          <h4>Keyboard Shortcuts</h4>
          <div className="shortcut-list">
            <div><kbd>V</kbd> Select mode</div>
            <div><kbd>N</kbd> Add node</div>
            <div><kbd>E</kbd> Add edge</div>
            <div><kbd>F</kbd> Add force</div>
            <div><kbd>Del</kbd> Delete selected</div>
            <div><kbd>Ctrl+Z</kbd> Undo</div>
            <div><kbd>Ctrl+Shift+Z</kbd> Redo</div>
            <div><kbd>Esc</kbd> Cancel / Deselect</div>
          </div>
        </div>

        {equilibrium && equilibrium.status !== 'no-structure' && (
          <div className="equilibrium-info">
            <h4>Equilibrium Status</h4>
            <div className={`status-badge ${equilibrium.status}`}>
              {equilibrium.status === 'determinate' ? 'Balanced' :
               equilibrium.status === 'unstable' ? 'Unstable' :
               equilibrium.status === 'indeterminate' ? 'Indeterminate' : '—'}
            </div>
            {equilibrium.status === 'determinate' && (
              <div className="force-summary">
                <h4>Member Forces</h4>
                {diagram.edges.map((edge) => {
                  const f = equilibrium.forces.get(edge.id);
                  if (f === undefined) return null;
                  const srcNode = diagram.nodes.find((n) => n.id === edge.source);
                  const tgtNode = diagram.nodes.find((n) => n.id === edge.target);
                  return (
                    <div
                      key={edge.id}
                      className={`force-item ${f > 0.001 ? 'tension' : f < -0.001 ? 'compression' : ''}`}
                      onClick={() => dispatch({ type: 'SELECT', ids: [edge.id] })}
                    >
                      <span className="force-label">
                        {srcNode ? `(${srcNode.x},${srcNode.y})` : '?'} →{' '}
                        {tgtNode ? `(${tgtNode.x},${tgtNode.y})` : '?'}
                      </span>
                      <span className="force-value">
                        {f > 0.001 ? 'T' : f < -0.001 ? 'C' : '0'}{' '}
                        {Math.abs(f).toFixed(3)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const selectedId = selectedIds[0];
  const selectedNode = diagram.nodes.find((n) => n.id === selectedId);
  const selectedEdge = diagram.edges.find((e) => e.id === selectedId);

  if (selectedNode) {
    return (
      <div className="properties-panel">
        <h3>Node Properties</h3>
        <div className="prop-group">
          <label>Position X</label>
          <input
            type="number"
            step="0.5"
            value={selectedNode.x}
            onChange={(e) =>
              dispatch({
                type: 'MOVE_NODE',
                id: selectedNode.id,
                x: parseFloat(e.target.value) || 0,
                y: selectedNode.y,
              })
            }
          />
        </div>
        <div className="prop-group">
          <label>Position Y</label>
          <input
            type="number"
            step="0.5"
            value={selectedNode.y}
            onChange={(e) =>
              dispatch({
                type: 'MOVE_NODE',
                id: selectedNode.id,
                x: selectedNode.x,
                y: parseFloat(e.target.value) || 0,
              })
            }
          />
        </div>
        <div className="prop-group">
          <label>Position Z (elevation)</label>
          <input
            type="number"
            step="0.5"
            value={selectedNode.z}
            onChange={(e) =>
              dispatch({
                type: 'MOVE_NODE',
                id: selectedNode.id,
                x: selectedNode.x,
                y: selectedNode.y,
                z: parseFloat(e.target.value) || 0,
              })
            }
          />
        </div>
        <div className="prop-group">
          <label>Support</label>
          <select
            value={selectedNode.support}
            onChange={(e) =>
              dispatch({
                type: 'SET_SUPPORT',
                id: selectedNode.id,
                support: e.target.value as SupportType,
              })
            }
          >
            <option value="free">Free</option>
            <option value="pin">Pin (fixed)</option>
            <option value="roller-x">Roller (vertical reaction)</option>
            <option value="roller-y">Roller (horizontal reaction)</option>
          </select>
        </div>
        <div className="prop-group">
          <label>External Force X</label>
          <input
            type="number"
            step="0.1"
            value={selectedNode.externalForce.x}
            onChange={(e) =>
              dispatch({
                type: 'SET_EXTERNAL_FORCE',
                id: selectedNode.id,
                fx: parseFloat(e.target.value) || 0,
                fy: selectedNode.externalForce.y,
              })
            }
          />
        </div>
        <div className="prop-group">
          <label>External Force Y</label>
          <input
            type="number"
            step="0.1"
            value={selectedNode.externalForce.y}
            onChange={(e) =>
              dispatch({
                type: 'SET_EXTERNAL_FORCE',
                id: selectedNode.id,
                fx: selectedNode.externalForce.x,
                fy: parseFloat(e.target.value) || 0,
              })
            }
          />
        </div>

        {equilibrium?.reactions?.has(selectedNode.id) && (
          <div className="prop-group">
            <label>Reaction</label>
            <span className="reaction-display">
              ({equilibrium.reactions.get(selectedNode.id)!.x.toFixed(3)},{' '}
              {equilibrium.reactions.get(selectedNode.id)!.y.toFixed(3)})
            </span>
          </div>
        )}

        <button
          className="delete-btn"
          onClick={() => dispatch({ type: 'DELETE_ELEMENT', id: selectedNode.id })}
        >
          Delete Node
        </button>
      </div>
    );
  }

  if (selectedEdge) {
    const f = equilibrium?.forces?.get(selectedEdge.id);
    return (
      <div className="properties-panel">
        <h3>Edge Properties</h3>
        <div className="prop-group">
          <label>Element Type</label>
          <select
            value={selectedEdge.elementType}
            onChange={(e) =>
              dispatch({
                type: 'SET_ELEMENT_TYPE',
                id: selectedEdge.id,
                elementType: e.target.value as ElementType,
              })
            }
          >
            <option value="compression">Compression (strut/plate)</option>
            <option value="tension">Tension (cable)</option>
          </select>
        </div>
        {selectedEdge.elementType === 'compression' && (
          <>
            <div className="prop-group">
              <label>Plate Width</label>
              <input
                type="number"
                step="0.05"
                min="0.05"
                value={selectedEdge.plateWidth}
                onChange={(e) =>
                  dispatch({
                    type: 'SET_PLATE_WIDTH',
                    id: selectedEdge.id,
                    width: Math.max(0.05, parseFloat(e.target.value) || 0.3),
                  })
                }
              />
            </div>
            <div className="prop-group">
              <label>Plate Angle (degrees)</label>
              <input
                type="number"
                step="5"
                value={selectedEdge.plateAngle}
                onChange={(e) =>
                  dispatch({
                    type: 'SET_PLATE_ANGLE',
                    id: selectedEdge.id,
                    angle: parseFloat(e.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="prop-group">
              <label>Plate Thickness (mm)</label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                value={selectedEdge.plateThickness}
                onChange={(e) =>
                  dispatch({
                    type: 'SET_PLATE_THICKNESS',
                    id: selectedEdge.id,
                    thickness: Math.max(0.5, parseFloat(e.target.value) || 3),
                  })
                }
              />
            </div>
          </>
        )}
        {f !== undefined && (
          <div className="prop-group">
            <label>Computed Force</label>
            <span className={`force-display ${f > 0.001 ? 'tension' : f < -0.001 ? 'compression' : ''}`}>
              {f > 0.001 ? 'Tension' : f < -0.001 ? 'Compression' : 'Zero'}: {Math.abs(f).toFixed(4)}
            </span>
          </div>
        )}
        <button
          className="delete-btn"
          onClick={() => dispatch({ type: 'DELETE_ELEMENT', id: selectedEdge.id })}
        >
          Delete Edge
        </button>
      </div>
    );
  }

  return (
    <div className="properties-panel">
      <h3>Properties</h3>
      <p className="hint-text">Unknown selection.</p>
    </div>
  );
}
