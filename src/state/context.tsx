import React, { createContext, useContext, useReducer, useRef, useCallback } from 'react';
import { AppState, AppAction, SearchRequest } from '../types';
import { appReducer, createInitialState } from './reducer';
import { searchClass1Tensegrity, buildTriplexManually } from '../morphogenesis/searchClass1';
import type { Vec3 } from '../morphogenesis/types';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  /**
   * Kick off an async Class-1 search. The search runs in chunks on
   * the event loop so the UI paints every intermediate state. If a
   * search is already running it is aborted first.
   */
  runSearch: (req: SearchRequest) => Promise<void>;
  /**
   * Run the hand-crafted Triplex construction (seed K₅ → adhere →
   * fuse BD → fuse CE) on the provided 6 points. Bypasses the
   * greedy search entirely so the user always gets the canonical
   * Aloui §5 result. Uses the same progress / tick plumbing as
   * runSearch, so Viewer3D and the event log update live.
   */
  runTriplex: (points: Vec3[], timeoutMs: number) => Promise<void>;
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

    try {
      const result = await searchClass1Tensegrity(req.n, req.points, req.seed, {
        timeoutMs: req.timeoutMs,
        signal: ctrl.signal,
        yieldToEventLoop: true,
        // No dispatch throttle — the search already paces itself via
        // requestAnimationFrame inside its yield, so every tick
        // corresponds to a browser frame. Dropping dispatches would
        // just cause the viewer to skip frames.
        onProgress: (progress) => {
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
        rigid: result.rigid,
        class1: result.class1,
        lpSuccess: result.success,
        bestClassK: result.bestClassK,
        allConnected: result.allConnected,
        bestResultNote: result.bestResultNote,
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
        rigid: false,
        class1: false,
        lpSuccess: false,
        bestClassK: 0,
        allConnected: false,
        bestResultNote: '',
      });
    }
  }, [state.morpho]);

  const runTriplex = useCallback(async (points: Vec3[], timeoutMs: number) => {
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;

    dispatch({ type: 'SEARCH_START', timeoutMs });

    try {
      const result = await buildTriplexManually(points, {
        timeoutMs,
        signal: ctrl.signal,
        yieldToEventLoop: true,
        onProgress: (progress) => {
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
        rigid: result.rigid,
        class1: result.class1,
        lpSuccess: result.success,
        bestClassK: result.bestClassK,
        allConnected: result.allConnected,
        bestResultNote: result.bestResultNote,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('buildTriplexManually failed:', err);
      dispatch({
        type: 'SEARCH_DONE',
        morpho: state.morpho,
        status: 'aborted',
        elapsedMs: 0,
        rigid: false,
        class1: false,
        lpSuccess: false,
        bestClassK: 0,
        allConnected: false,
        bestResultNote: '',
      });
    }
  }, [state.morpho]);

  const stopSearch = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch, runSearch, runTriplex, stopSearch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
