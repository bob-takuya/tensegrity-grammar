import { AppState, AppAction, SearchLiveInfo } from '../types';
import { createEmptyState } from '../morphogenesis/engine';

function initialSearchInfo(): SearchLiveInfo {
  return {
    status: 'idle',
    tick: 0,
    phase: '',
    elapsedMs: 0,
    remainingMs: 0,
    timeoutMs: 0,
    rigid: false,
    class1: false,
    lpSuccess: false,
    bestClassK: 0,
    allConnected: false,
    bestResultNote: '',
  };
}

export function createInitialState(): AppState {
  return {
    morpho: createEmptyState(),
    selectedNodeIds: [],
    selectedMemberIds: [],
    search: initialSearchInfo(),
  };
}

/**
 * Shallow-clone the live morphogenesis state so React sees a new
 * reference on every tick. The inner arrays are the *same* references
 * that the search mutates in-place — consumers should treat them as
 * append-only streams, not mutate-in-place snapshots. Creating a
 * fresh outer object is cheap and enough to re-trigger `useEffect`
 * dependencies that watch `state.morpho`.
 */
function shallowCloneMorpho(m: AppState['morpho']): AppState['morpho'] {
  return {
    ...m,
    nodes: m.nodes.slice(),
    members: m.members.slice(),
    cells: m.cells.slice(),
    cellMembers: m.cellMembers.slice(),
    cellAdjacency: m.cellAdjacency.slice(),
    selfStressStates: m.selfStressStates.slice(),
    selfStressEntries: m.selfStressEntries.slice(),
    morphogenesisSteps: m.morphogenesisSteps.slice(),
    removedMembers: m.removedMembers.slice(),
    events: m.events.slice(),
    alpha: m.alpha.slice(),
    matching: m.matching.slice(),
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SEARCH_START':
      return {
        ...state,
        // Start with a fresh empty morphogenesis state so previous
        // runs don't bleed through.
        morpho: createEmptyState(),
        selectedNodeIds: [],
        selectedMemberIds: [],
        search: {
          status: 'running',
          tick: 0,
          phase: 'starting…',
          elapsedMs: 0,
          remainingMs: action.timeoutMs,
          timeoutMs: action.timeoutMs,
          // Clear validation flags — we don't know anything yet.
          rigid: false,
          class1: false,
          lpSuccess: false,
          bestClassK: 0,
          allConnected: false,
          bestResultNote: '',
        },
      };

    case 'SEARCH_TICK':
      return {
        ...state,
        morpho: shallowCloneMorpho(action.morpho),
        search: {
          ...state.search,
          status: 'running',
          tick: action.tick,
          phase: action.phase,
          elapsedMs: action.elapsedMs,
          remainingMs: action.remainingMs,
        },
      };

    case 'SEARCH_DONE':
      return {
        ...state,
        morpho: shallowCloneMorpho(action.morpho),
        search: {
          ...state.search,
          status: action.status,
          elapsedMs: action.elapsedMs,
          remainingMs: Math.max(0, state.search.timeoutMs - action.elapsedMs),
          rigid: action.rigid,
          class1: action.class1,
          lpSuccess: action.lpSuccess,
          bestClassK: action.bestClassK,
          allConnected: action.allConnected,
          bestResultNote: action.bestResultNote,
        },
      };

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
