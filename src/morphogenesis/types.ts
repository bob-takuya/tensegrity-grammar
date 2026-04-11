/**
 * Data types for Cellular Morphogenesis engine.
 *
 * Based on: Aloui, Orden, Rhode-Barbarigos (2019)
 * "Cellular morphogenesis of three-dimensional tensegrity structures"
 */

// ─── Geometry ────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

// ─── Structure Graph G(V, E) ─────────────────────────────────────

export interface MNode {
  id: number;
  pos: Vec3;
}

export interface MEdge {
  id: number;
  n: [number, number];        // node ids
  type: 'strut' | 'cable' | 'unassigned';
  forceDensity: number;        // w_ij: positive = tension, negative = compression
}

export interface StructureGraph {
  nodes: MNode[];
  edges: MEdge[];
  nextNodeId: number;
  nextEdgeId: number;
}

// ─── K₅ Cell ─────────────────────────────────────────────────────

export interface K5Cell {
  id: number;
  nodeIds: number[];           // always 5 nodes
  edgeIds: number[];           // always 10 edges (K₅ complete graph)
  selfStress: number[];        // force density vector (10 entries, one per edge)
  signPattern: 'typeI' | 'typeII';  // 6+/4− or 4+/6−
}

// ─── Morphogenesis Graph Gc(Vc, Ec) ──────────────────────────────

export interface CellBoundary {
  cells: [number, number];     // cell ids
  sharedEdges: number[];       // edge ids shared between the two cells
}

export interface MorphogenesisState {
  graph: StructureGraph;
  cells: K5Cell[];
  boundaries: CellBoundary[];
  stressBasis: number[][];     // each column is a self-stress basis vector
  nextCellId: number;
  history: HistoryEntry[];
  historyIndex: number;
}

export interface HistoryEntry {
  label: string;
  snapshot: string;  // JSON serialized state (without history)
}
