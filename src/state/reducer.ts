import { AppState, AppAction } from '../types';
import { createEmptyState, autoGrow } from '../morphogenesis/engine';
import { fuseOneEdge, executeTwoEdgeFusion } from '../morphogenesis/fusion';

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
        maxCompDeg: action.maxCompDeg,
        adhesionAttempts: action.adhesionAttempts,
      });
      return { ...state, morpho, selectedNodeIds: [], selectedEdgeIds: [] };
    }

    case 'CLEAR':
      return createInitialState();

    case 'SELECT_NODES':
      return { ...state, selectedNodeIds: action.ids, selectedEdgeIds: [] };

    case 'SELECT_EDGES':
      return { ...state, selectedEdgeIds: action.ids, selectedNodeIds: [] };

    case 'FUSE_EDGE': {
      // Clone morpho state for immutability
      const morpho = JSON.parse(JSON.stringify(state.morpho));
      fuseOneEdge(morpho, action.edgeId);
      return { ...state, morpho, selectedEdgeIds: [] };
    }

    case 'FUSE_TWO_EDGES': {
      const morpho = JSON.parse(JSON.stringify(state.morpho));
      executeTwoEdgeFusion(morpho, action.edgeId1, action.edgeId2);
      return { ...state, morpho, selectedEdgeIds: [] };
    }

    case 'UNDO':
    case 'REDO':
      return state; // TODO

    default:
      return state;
  }
}
