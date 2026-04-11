/**
 * App-level types for Tensegrity Morphogenesis tool.
 * Core data types are in src/morphogenesis/types.ts.
 */

import type { MorphogenesisState } from './morphogenesis/types';

export interface AppState {
  morpho: MorphogenesisState;
  selectedNodeIds: number[];
  selectedEdgeIds: number[];
}

export type AppAction =
  | { type: 'GENERATE'; numCells: number; spread: number; fuseProbability: number }
  | { type: 'CLEAR' }
  | { type: 'SELECT_NODES'; ids: number[] }
  | { type: 'SELECT_EDGES'; ids: number[] }
  | { type: 'FUSE_EDGE'; edgeId: number }
  | { type: 'FUSE_TWO_EDGES'; edgeId1: number; edgeId2: number }
  | { type: 'UNDO' }
  | { type: 'REDO' };
