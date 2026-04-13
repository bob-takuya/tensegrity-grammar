/**
 * App-level types for the Cellular Morphogenesis tool.
 * Core tables live in src/morphogenesis/types.ts and follow the
 * schema defined by Aloui et al. (2019).
 */

import type { MorphogenesisState, Vec3 } from './morphogenesis/types';

export interface AppState {
  morpho: MorphogenesisState;
  selectedNodeIds: number[];
  selectedMemberIds: number[];
}

export type AppAction =
  | { type: 'SEARCH'; n: number; points: Vec3[] | null; seed?: number }
  | { type: 'CLEAR' }
  | { type: 'SELECT_NODES'; ids: number[] }
  | { type: 'SELECT_MEMBERS'; ids: number[] };
