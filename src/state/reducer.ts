import { AppState, AppAction } from '../types';
import { createEmptyState, autoGrow, assignForceDensities } from '../morphogenesis/engine';
import { fuseOneEdge, fuseTwoEdges } from '../morphogenesis/fusion';

export function createInitialState(): AppState {
  return {
    morpho: createEmptyState(),
    selectedNodeIds: [],
    selectedMemberIds: [],
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
      return {
        ...state,
        morpho,
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

    case 'FUSE_MEMBER': {
      const morpho = JSON.parse(JSON.stringify(state.morpho));
      fuseOneEdge(morpho, action.memberId);
      assignForceDensities(morpho);
      return { ...state, morpho, selectedMemberIds: [] };
    }

    case 'FUSE_TWO_MEMBERS': {
      const morpho = JSON.parse(JSON.stringify(state.morpho));
      fuseTwoEdges(morpho, action.memberId1, action.memberId2);
      assignForceDensities(morpho);
      return { ...state, morpho, selectedMemberIds: [] };
    }

    case 'UNDO':
    case 'REDO':
      return state;

    default:
      return state;
  }
}
