import { AppState, AppAction } from '../types';
import { createEmptyState } from '../morphogenesis/engine';
import { searchClass1Tensegrity } from '../morphogenesis/searchClass1';

export function createInitialState(): AppState {
  return {
    morpho: createEmptyState(),
    selectedNodeIds: [],
    selectedMemberIds: [],
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SEARCH': {
      const result = searchClass1Tensegrity(action.n, action.points, action.seed);
      return {
        ...state,
        morpho: result.state,
        selectedNodeIds: [],
        selectedMemberIds: [],
      };
    }

    case 'CLEAR':
      return createInitialState();

    case 'SELECT_NODES':
      return { ...state, selectedNodeIds: action.ids, selectedMemberIds: [] };

    case 'SELECT_MEMBERS':
      return { ...state, selectedMemberIds: action.ids, selectedNodeIds: [] };

    default:
      return state;
  }
}
