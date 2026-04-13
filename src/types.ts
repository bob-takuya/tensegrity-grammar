/**
 * App-level types for the Cellular Morphogenesis tool.
 * Core tables live in src/morphogenesis/types.ts and follow the
 * schema defined by Aloui et al. (2019).
 */

import type { MorphogenesisState } from './morphogenesis/types';

export interface AppState {
  morpho: MorphogenesisState;
  selectedNodeIds: number[];
  selectedMemberIds: number[];
}

export type AppAction =
  | { type: 'GENERATE'; numCells: number; spread: number; fuseProbability: number; maxCompDeg: number; adhesionAttempts: number }
  | { type: 'CLEAR' }
  | { type: 'SELECT_NODES'; ids: number[] }
  | { type: 'SELECT_MEMBERS'; ids: number[] }
  | { type: 'FUSE_MEMBER'; memberId: number }
  | { type: 'FUSE_TWO_MEMBERS'; memberId1: number; memberId2: number }
  | { type: 'UNDO' }
  | { type: 'REDO' };
