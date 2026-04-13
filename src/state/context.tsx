import React, { createContext, useContext, useReducer, useRef, useCallback } from 'react';
import { AppState, AppAction, SearchRequest } from '../types';
import { appReducer, createInitialState } from './reducer';
import { searchClass1Tensegrity } from '../morphogenesis/searchClass1';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  /**
   * Kick off an async Class-1 search. The search runs in chunks on
   * the event loop so the UI paints every intermediate state. If a
   * search is already running it is aborted first.
   */
  runSearch: (req: SearchRequest) => Promise<void>;
  /** Abort the currently running search, if any. */
  stopSearch: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState);

  // Mutable handle on the active AbortController so callers can
  // cancel without having to hold the promise themselves.
  const controllerRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (req: SearchRequest) => {
    // Cancel any previous run cleanly.
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;

    dispatch({ type: 'SEARCH_START', timeoutMs: req.timeoutMs });

    // Throttle UI dispatches: we don't need to re-render faster than
    // the browser paints (~60 Hz = 16 ms). Dispatches in between are
    // still picked up at the next tick because the state object is
    // mutated in-place by the search.
    const MIN_DISPATCH_INTERVAL_MS = 16;
    let lastDispatchAt = 0;

    try {
      const result = await searchClass1Tensegrity(req.n, req.points, req.seed, {
        timeoutMs: req.timeoutMs,
        signal: ctrl.signal,
        yieldToEventLoop: true,
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastDispatchAt < MIN_DISPATCH_INTERVAL_MS) return;
          lastDispatchAt = now;
          dispatch({
            type: 'SEARCH_TICK',
            morpho: progress.state,
            phase: progress.phase,
            tick: progress.tick,
            elapsedMs: progress.elapsedMs,
            remainingMs: progress.remainingMs,
          });
        },
      });

      dispatch({
        type: 'SEARCH_DONE',
        morpho: result.state,
        status: ctrl.signal.aborted
          ? 'aborted'
          : result.timedOut
            ? 'timeout'
            : 'done',
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      // A thrown error during the search shouldn't crash the app.
      // Report it in the console and mark the run aborted so the
      // UI recovers gracefully.
      // eslint-disable-next-line no-console
      console.error('searchClass1Tensegrity failed:', err);
      dispatch({
        type: 'SEARCH_DONE',
        morpho: state.morpho,
        status: 'aborted',
        elapsedMs: 0,
      });
    }
  }, [state.morpho]);

  const stopSearch = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch, runSearch, stopSearch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
