// ─── Support Types ───────────────────────────────────────────────
export type SupportType = 'free' | 'pin' | 'roller-x' | 'roller-y';

// ─── Edit Modes ──────────────────────────────────────────────────
export type EditMode = 'select' | 'addNode' | 'addEdge' | 'addForce' | 'delete';

// ─── Element Types ───────────────────────────────────────────────
export type ElementType = 'compression' | 'tension';

// ─── Core Data Types ─────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DiagramNode {
  id: string;
  x: number;
  y: number;
  z: number;           // 3D elevation
  support: SupportType;
  externalForce: Vec2;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  elementType: ElementType;
  // Plate properties (Phase 3: tensegrity)
  plateWidth: number;    // width of the plate (perpendicular to edge), world units
  plateThickness: number; // thickness of the plate (for fabrication), mm
  plateAngle: number;    // rotation angle of plate around its axis (degrees)
}

// ─── Diagram Data (serializable snapshot) ────────────────────────

export interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

// ─── Equilibrium Result ──────────────────────────────────────────

export interface EquilibriumResult {
  forces: Map<string, number>;       // edge id → force (+ tension, − compression)
  reactions: Map<string, Vec2>;      // node id → reaction force
  status: 'determinate' | 'indeterminate' | 'unstable' | 'no-structure';
  residual: number;                  // max equilibrium residual
}

// ─── Force Diagram Data ──────────────────────────────────────────

export interface ForceDiagramNode {
  id: string;       // face id from half-edge structure
  x: number;
  y: number;
}

export interface ForceDiagramEdge {
  id: string;        // matches form edge id
  source: string;    // face id
  target: string;    // face id
  force: number;
}

export interface ForceDiagramData {
  nodes: ForceDiagramNode[];
  edges: ForceDiagramEdge[];
}

// ─── Force Polygons (per-node visualization) ─────────────────────

export interface ForcePolygonSegment {
  label: string;         // edge id, "external", or "reaction"
  dx: number;            // force vector x
  dy: number;            // force vector y
  type: 'member' | 'external' | 'reaction';
  force: number;         // signed force magnitude
}

export interface ForcePolygon {
  nodeId: string;
  segments: ForcePolygonSegment[];
  vertices: Vec2[];      // cumulative vertices (head-to-tail)
  closes: boolean;
  residual: Vec2;
}

// ─── Tensegrity Validation ────────────────────────────────────────

export interface TensegrityResult {
  isValid: boolean;
  compressionCount: number;
  tensionCount: number;
  issues: string[];
  // Per-plate info for fabrication
  plates: PlateInfo[];
  cables: CableInfo[];
}

export interface PlateInfo {
  edgeId: string;
  label: string;
  length: number;
  width: number;
  thickness: number;
  // Corner coordinates for DXF export (world coords)
  corners: [Vec2, Vec2, Vec2, Vec2];
}

export interface CableInfo {
  edgeId: string;
  label: string;
  length: number;
  sourceNodeId: string;
  targetNodeId: string;
}

// ─── App State ───────────────────────────────────────────────────

import type { RuleMatch, HistoryTree } from './grammar/types';
import type { ForceGrammarState } from './grammar/forceGrammar';

export interface AppState {
  diagram: DiagramData;
  equilibrium: EquilibriumResult | null;
  forceDiagram: ForceDiagramData | null;
  forcePolygons: ForcePolygon[];
  selectedIds: string[];
  mode: EditMode;
  edgeStartNode: string | null;
  forceStartNode: string | null;
  undoStack: DiagramData[];
  redoStack: DiagramData[];
  // Grammar (Phase 2)
  selectedRuleId: string | null;
  ruleMatches: RuleMatch[];
  ruleParams: Record<string, number>;
  highlightedMatchIndex: number | null;
  historyTree: HistoryTree | null;
  // Force-based grammar (Mirtsopoulos & Fivet)
  forceGrammar: ForceGrammarState;
  // Global settings
  globalPlateThickness: number; // mm — shared by all plates
}

// ─── Actions ─────────────────────────────────────────────────────

export type AppAction =
  | { type: 'ADD_NODE'; x: number; y: number }
  | { type: 'MOVE_NODE'; id: string; x: number; y: number; z?: number }
  | { type: 'DELETE_ELEMENT'; id: string }
  | { type: 'ADD_EDGE'; source: string; target: string }
  | { type: 'SET_SUPPORT'; id: string; support: SupportType }
  | { type: 'SET_EXTERNAL_FORCE'; id: string; fx: number; fy: number }
  | { type: 'SET_ELEMENT_TYPE'; id: string; elementType: ElementType }
  | { type: 'SET_PLATE_WIDTH'; id: string; width: number }
  | { type: 'SET_PLATE_THICKNESS'; id: string; thickness: number }
  | { type: 'SET_PLATE_ANGLE'; id: string; angle: number }
  | { type: 'SELECT'; ids: string[] }
  | { type: 'SET_MODE'; mode: EditMode }
  | { type: 'SET_EDGE_START'; id: string | null }
  | { type: 'SET_FORCE_START'; id: string | null }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'LOAD_STATE'; data: DiagramData }
  | { type: 'RECOMPUTE' }
  | { type: 'PUSH_UNDO' }
  // Grammar actions
  | { type: 'SELECT_RULE'; ruleId: string | null }
  | { type: 'SET_RULE_PARAM'; key: string; value: number }
  | { type: 'HIGHLIGHT_MATCH'; index: number | null }
  | { type: 'APPLY_RULE'; matchIndex: number }
  | { type: 'NAVIGATE_HISTORY'; historyId: string }
  | { type: 'AUTO_EXPLORE'; steps: number }
  // Force-based grammar actions
  | { type: 'START_FORCE_GRAMMAR' }
  | { type: 'STOP_FORCE_GRAMMAR' }
  | { type: 'SELECT_INTERIM_FORCE'; forceId: string | null }
  | { type: 'RESOLVE_FORCE_ADD_NODE'; forceId: string; x: number; y: number }
  | { type: 'RESOLVE_FORCE_CONNECT'; forceId: string; targetNodeId: string }
  | { type: 'FORCE_GRAMMAR_AUTO_EXPLORE'; steps: number }
  | { type: 'SET_GLOBAL_PLATE_THICKNESS'; thickness: number };
