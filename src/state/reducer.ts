import { AppState, AppAction } from '../types';
import { createEmptyState, autoGrow } from '../morphogenesis/engine';

export function createInitialState(): AppState {
  return {
    morpho: createEmptyState(),
    selectedNodeIds: [],
    selectedEdgeIds: [],
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'GENERATE': {
      const morpho = createEmptyState();
      autoGrow(morpho, action.numCells, {
        spread: action.spread,
        fuseProbability: action.fuseProbability,
      });
      return { ...state, morpho, selectedNodeIds: [], selectedEdgeIds: [] };
    }

    case 'CLEAR':
      return createInitialState();

    case 'SELECT_NODES':
      return { ...state, selectedNodeIds: action.ids, selectedEdgeIds: [] };

    case 'SELECT_EDGES':
      return { ...state, selectedEdgeIds: action.ids, selectedNodeIds: [] };

    case 'UNDO':
    case 'REDO':
      // TODO: implement undo/redo with morpho.history
      return state;

    default:
      return state;
  }
}
