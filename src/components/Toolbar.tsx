import React, { useCallback } from 'react';
import { useAppState } from '../state/context';
import { EditMode, DiagramData } from '../types';
import { applySelfWeight } from '../engine/gravity';

const modes: { mode: EditMode; label: string; shortcut: string; icon: string }[] = [
  { mode: 'select', label: 'Select', shortcut: 'V', icon: '⇲' },
  { mode: 'addNode', label: 'Node', shortcut: 'N', icon: '●' },
  { mode: 'addEdge', label: 'Edge', shortcut: 'E', icon: '╱' },
  { mode: 'addForce', label: 'Force', shortcut: 'F', icon: '↓' },
  { mode: 'delete', label: 'Delete', shortcut: 'Del', icon: '✕' },
];

export function Toolbar() {
  const { state, dispatch } = useAppState();

  const handleSave = useCallback(() => {
    const data = JSON.stringify(state.diagram, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tensegrity-diagram.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [state.diagram]);

  const handleLoad = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string) as DiagramData;
          dispatch({ type: 'LOAD_STATE', data });
        } catch {
          alert('Invalid file format');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [dispatch]);

  return (
    <div className="toolbar">
      <div className="toolbar-group toolbar-title">
        <span className="app-title">Tensegrity Grammar</span>
      </div>

      <div className="toolbar-group">
        {modes.map((m) => (
          <button
            key={m.mode}
            className={`tool-btn ${state.mode === m.mode ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_MODE', mode: m.mode })}
            title={`${m.label} (${m.shortcut})`}
          >
            <span className="tool-icon">{m.icon}</span>
            <span className="tool-label">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        <button
          className="tool-btn"
          onClick={() => dispatch({ type: 'UNDO' })}
          disabled={state.undoStack.length === 0}
          title="Undo (Ctrl+Z)"
        >
          ↩ Undo
        </button>
        <button
          className="tool-btn"
          onClick={() => dispatch({ type: 'REDO' })}
          disabled={state.redoStack.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↪ Redo
        </button>
      </div>

      <div className="toolbar-group">
        <button className="tool-btn" onClick={handleSave} title="Save diagram to JSON">
          💾 Save
        </button>
        <button className="tool-btn" onClick={handleLoad} title="Load diagram from JSON">
          📂 Load
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className="tool-btn"
          onClick={() => {
            const updated = applySelfWeight(state.diagram);
            dispatch({ type: 'LOAD_STATE', data: updated });
          }}
          title="Compute and apply self-weight (gravity) from plate masses"
        >
          ⬇ Self-Weight
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group toolbar-info">
        <span className="info-text">
          Nodes: {state.diagram.nodes.length} | Edges: {state.diagram.edges.length}
        </span>
      </div>
    </div>
  );
}
