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
 * reference on every tick. We only spread the outer object — the
 * inner arrays (nodes, members, events, …) are passed by reference.
 * That is intentional: the search mutates them in place between
 * yields, and the only thing React needs to re-run effects is a new
 * outer object reference. Keeping the inner references stable lets
 * downstream `useMemo` / `React.memo` bail out when the underlying
 * array hasn't actually changed — e.g. `strutIds` on `m.matching`,
 * the memoised `EventList`, etc. Copying all 12 inner arrays on
 * every tick was a measurable overhead (~1 ms/tick) AND defeated
 * the child memoisation.
 */
function shallowCloneMorpho(m: AppState['morpho']): AppState['morpho'] {
  return { ...m };
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
