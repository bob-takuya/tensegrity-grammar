import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import { AppState, AppAction, DiagramData } from '../types';
import { appReducer, createInitialState } from './reducer';

// ─── Default example: simple Warren truss ────────────────────────
function createDefaultDiagram(): DiagramData {
  return {
    nodes: [
      { id: 'n0', x: 0, y: 0, support: 'pin', externalForce: { x: 0, y: 0 } },
      { id: 'n1', x: 4, y: 0, support: 'roller-x', externalForce: { x: 0, y: 0 } },
      { id: 'n2', x: 2, y: 2, support: 'free', externalForce: { x: 0, y: -2 } },
    ],
    edges: [
      { id: 'e0', source: 'n0', target: 'n1', elementType: 'compression' as const, plateWidth: 0.3, plateThickness: 3 },
      { id: 'e1', source: 'n0', target: 'n2', elementType: 'compression' as const, plateWidth: 0.3, plateThickness: 3 },
      { id: 'e2', source: 'n1', target: 'n2', elementType: 'compression' as const, plateWidth: 0.3, plateThickness: 3 },
    ],
  };
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(
    appReducer,
    createDefaultDiagram(),
    createInitialState
  );

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) ||
        ((e.ctrlKey || e.metaKey) && e.key === 'y')
      ) {
        e.preventDefault();
        dispatch({ type: 'REDO' });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedIds.length > 0) {
          e.preventDefault();
          for (const id of state.selectedIds) {
            dispatch({ type: 'DELETE_ELEMENT', id });
          }
        }
      } else if (e.key === 'Escape') {
        dispatch({ type: 'SET_MODE', mode: 'select' });
        dispatch({ type: 'SELECT', ids: [] });
      } else if (e.key === 'v' || e.key === 'V') {
        dispatch({ type: 'SET_MODE', mode: 'select' });
      } else if (e.key === 'n' || e.key === 'N') {
        dispatch({ type: 'SET_MODE', mode: 'addNode' });
      } else if (e.key === 'e' || e.key === 'E') {
        dispatch({ type: 'SET_MODE', mode: 'addEdge' });
      } else if (e.key === 'f' || e.key === 'F') {
        dispatch({ type: 'SET_MODE', mode: 'addForce' });
      }
    },
    [state.selectedIds, dispatch]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
