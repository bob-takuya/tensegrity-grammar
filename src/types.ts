/**
 * App-level types for the Cellular Morphogenesis tool.
 * Core tables live in src/morphogenesis/types.ts and follow the
 * schema defined by Aloui et al. (2019).
 */

import type { MorphogenesisState, Vec3 } from './morphogenesis/types';

/**
 * Where the search currently is. The UI uses this to decide whether
 * to show the "Search" button, the "Running…" spinner + Stop button,
 * or the final status line.
 */
export type SearchStatus = 'idle' | 'running' | 'done' | 'timeout' | 'aborted';

export interface SearchLiveInfo {
  status: SearchStatus;
  /** Monotonic tick counter; bumped each time onProgress fires. */
  tick: number;
  /** Most recent phase label emitted by the search. */
  phase: string;
  /** Wall-clock elapsed (ms) at the last tick. */
  elapsedMs: number;
  /** Remaining budget (ms) at the last tick; ≤0 once timed out. */
  remainingMs: number;
  /** Full timeout budget (ms) the current run was started with. */
  timeoutMs: number;
  /**
   * Validation flags populated on SEARCH_DONE. All false while the
   * search is still running. The UI uses these to decide whether to
   * render a green "Class-1 achieved" badge — recomputing it from
   * live morpho state (as the old ControlPanel did) is fragile
   * because an empty strut set trivially satisfies the matching
   * condition yet is clearly not a tensegrity.
   */
  rigid: boolean;
  class1: boolean;
  lpSuccess: boolean;
  /**
   * Class-k of the returned structure (1 = ideal Class-1,
   * higher = worse). 0 means the structure has no struts at all.
   */
  bestClassK: number;
  /** True iff every input node has at least one incident member. */
  allConnected: boolean;
  /** Human-readable summary from the search driver. */
  bestResultNote: string;
}

export interface AppState {
  morpho: MorphogenesisState;
  selectedNodeIds: number[];
  selectedMemberIds: number[];
  search: SearchLiveInfo;
}

export type AppAction =
  | { type: 'SEARCH_START'; timeoutMs: number }
  | {
      type: 'SEARCH_TICK';
      morpho: MorphogenesisState;
      phase: string;
      tick: number;
      elapsedMs: number;
      remainingMs: number;
    }
  | {
      type: 'SEARCH_DONE';
      morpho: MorphogenesisState;
      status: 'done' | 'timeout' | 'aborted';
      elapsedMs: number;
      rigid: boolean;
      class1: boolean;
      lpSuccess: boolean;
      bestClassK: number;
      allConnected: boolean;
      bestResultNote: string;
    }
  | { type: 'CLEAR' }
  | { type: 'SELECT_NODES'; ids: number[] }
  | { type: 'SELECT_MEMBERS'; ids: number[] };

// The payload shape of SEARCH_START that the UI provides to the
// async driver. Kept here so callers don't have to reach into the
// morphogenesis package.
export interface SearchRequest {
  n: number;
  points: Vec3[] | null;
  seed?: number;
  timeoutMs: number;
}
