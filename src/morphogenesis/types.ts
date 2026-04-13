/**
 * Cellular Morphogenesis — Data Schema
 *
 * Based on: Aloui, Orden, Rhode-Barbarigos (2019)
 * "Cellular morphogenesis of three-dimensional tensegrity structures"
 *
 * This module defines the relational schema for the morphogenesis engine
 * as a set of in-memory "tables". Each table corresponds to an entity in
 * the specification; many-to-many links are modelled as explicit join rows
 * so the state can be serialised, diffed, and step-traced.
 *
 * Tables:
 *   NODE              — 3D vertex positions
 *   MEMBER            — undirected struts/cables/candidates
 *   CELL              — K₅ cells (regular / virtual / fused)
 *   CELL_MEMBER       — cell ↔ member join
 *   CELL_ADJACENCY    — edges of G_c (morphogenesis graph)
 *   SELF_STRESS_STATE — columns of W (self-stress basis)
 *   SELF_STRESS_ENTRY — sparse (state, member, w_value) triples
 *   MORPHOGENESIS_STEP— journal of adhesion / fusion operations
 *   REMOVED_MEMBER    — members dropped during a fusion step
 */

// ─── Geometry ────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

// ─── Enumerated types ────────────────────────────────────────────

export type MemberType = 'strut' | 'cable' | 'candidate';
export type CellType   = 'regular' | 'virtual' | 'fused';
export type Operation  = 'init' | 'adhesion' | 'fusion';

// ─── NODE ────────────────────────────────────────────────────────

export interface NodeRow {
  node_id: number;  // PK
  x: number;
  y: number;
  z: number;
}

// ─── MEMBER ──────────────────────────────────────────────────────

export interface MemberRow {
  member_id: number;            // PK
  node_a: number;               // FK → NODE, node_a < node_b
  node_b: number;               // FK → NODE
  type: MemberType;             // strut / cable / candidate
  force_density: number | null; // q_ij = w_ij / ||p_i - p_j|| (null until a w* is chosen)
}

// ─── CELL ────────────────────────────────────────────────────────

export interface CellRow {
  cell_id: number;               // PK
  cell_type: CellType;           // regular / virtual / fused
  step_created: number;          // FK → MORPHOGENESIS_STEP
  node_ids: number[];            // 5 node_ids that span this K₅
}

// ─── CELL_MEMBER (join) ─────────────────────────────────────────

export interface CellMemberRow {
  cell_id: number;               // FK → CELL
  member_id: number;             // FK → MEMBER
}

// ─── CELL_ADJACENCY ─────────────────────────────────────────────

export interface CellAdjacencyRow {
  cell_i: number;                // FK → CELL
  cell_j: number;                // FK → CELL
  shared_members: number[];      // list of member_ids shared by both cells
}

// ─── SELF_STRESS_STATE ──────────────────────────────────────────

export interface SelfStressStateRow {
  state_id: number;              // PK; column index in W
  cell_id: number | null;        // FK → CELL; null when state is a linear combination
}

// ─── SELF_STRESS_ENTRY (sparse W) ───────────────────────────────

export interface SelfStressEntryRow {
  state_id: number;              // FK → SELF_STRESS_STATE
  member_id: number;             // FK → MEMBER
  w_value: number;               // W_{e,k}
}

// ─── MORPHOGENESIS_STEP ─────────────────────────────────────────

export interface MorphogenesisStepRow {
  step_id: number;               // PK
  operation: Operation;          // init / adhesion / fusion
  delta_e: number;               // added members this step
  delta_v: number;               // added nodes this step
  delta_dim_W_predicted: number; // Corollary: e_i - 3 v_i
  delta_dim_W_actual: number;    // columns of W actually added
}

// ─── REMOVED_MEMBER ─────────────────────────────────────────────

export interface RemovedMemberRow {
  step_id: number;               // FK → MORPHOGENESIS_STEP
  member_id: number;             // FK → MEMBER (member prior to removal)
}

// ─── SEARCH_EVENT ───────────────────────────────────────────────

export type SearchEventKind =
  | 'phase'           // high-level phase boundary
  | 'init'            // seed K₅ placed
  | 'adhesion'        // one adhesion step executed
  | 'fusion'          // one fusion step executed
  | 'lp_check'        // LP feasibility attempt
  | 'conflict'        // one LP conflict identified
  | 'strategic_fusion'// strategic fusion triggered to break a conflict
  | 'matching'        // current maximum matching snapshot
  | 'success'         // final Class-1 solution reached
  | 'failure'         // algorithm gave up / fell back
  | 'info';           // any other progress note

export interface SearchEvent {
  event_id: number;
  kind: SearchEventKind;
  message: string;
  // Optional payloads used by the UI panel
  dim_W_before?: number;
  dim_W_after?: number;
  cell_id?: number;
  member_ids?: number[];
  node_ids?: number[];
  matching_ids?: number[];
  conflict_count?: number;
}

// ─── Aggregate state ────────────────────────────────────────────

export interface MorphogenesisState {
  // Tables
  nodes: NodeRow[];
  members: MemberRow[];
  cells: CellRow[];
  cellMembers: CellMemberRow[];
  cellAdjacency: CellAdjacencyRow[];
  selfStressStates: SelfStressStateRow[];
  selfStressEntries: SelfStressEntryRow[];
  morphogenesisSteps: MorphogenesisStepRow[];
  removedMembers: RemovedMemberRow[];

  // Search trace (populated by searchClass1Tensegrity)
  events: SearchEvent[];

  // Current chosen self-stress coefficient vector α (length = dim W)
  alpha: number[];

  // Current matching (member_ids chosen as struts)
  matching: number[];

  // Auto-increment counters
  nextNodeId: number;
  nextMemberId: number;
  nextCellId: number;
  nextStateId: number;
  nextStepId: number;
  nextEventId: number;
}
