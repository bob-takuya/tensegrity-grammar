import {
  AppState,
  AppAction,
  DiagramData,
  DiagramNode,
  DiagramEdge,
} from '../types';
import { generateId } from '../utils/id';
import { computeEquilibrium } from '../engine/equilibrium';
import { buildHalfEdgeStructure } from '../engine/halfEdge';
import { constructForceDiagram, computeForcePolygons } from '../engine/forceDiagram';

const MAX_UNDO = 50;

function cloneDiagram(d: DiagramData): DiagramData {
  return {
    nodes: d.nodes.map((n) => ({ ...n, externalForce: { ...n.externalForce } })),
    edges: d.edges.map((e) => ({ ...e })),
  };
}

function recompute(state: AppState): AppState {
  const { nodes, edges } = state.diagram;
  if (nodes.length === 0 || edges.length === 0) {
    return { ...state, equilibrium: null, forceDiagram: null, forcePolygons: [] };
  }

  const equilibrium = computeEquilibrium(nodes, edges);

  let forceDiagram = null;
  let forcePolygons: import('../types').ForcePolygon[] = [];

  if (equilibrium.status === 'determinate' && equilibrium.forces.size > 0) {
    try {
      const heStruct = buildHalfEdgeStructure(nodes, edges);
      forceDiagram = constructForceDiagram(nodes, edges, heStruct, equilibrium.forces);
    } catch {
      // Force diagram construction may fail for degenerate graphs
    }
    forcePolygons = computeForcePolygons(nodes, edges, equilibrium);
  }

  return { ...state, equilibrium, forceDiagram, forcePolygons };
}

function pushUndo(state: AppState): AppState {
  const undoStack = [...state.undoStack, cloneDiagram(state.diagram)];
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  return { ...state, undoStack, redoStack: [] };
}

export function createInitialState(diagram?: DiagramData): AppState {
  const state: AppState = {
    diagram: diagram || { nodes: [], edges: [] },
    equilibrium: null,
    forceDiagram: null,
    forcePolygons: [],
    selectedIds: [],
    mode: 'select',
    edgeStartNode: null,
    forceStartNode: null,
    undoStack: [],
    redoStack: [],
  };
  return recompute(state);
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'ADD_NODE': {
      const s = pushUndo(state);
      const node: DiagramNode = {
        id: generateId('n'),
        x: action.x,
        y: action.y,
        support: 'free',
        externalForce: { x: 0, y: 0 },
      };
      const diagram = {
        ...s.diagram,
        nodes: [...s.diagram.nodes, node],
      };
      return recompute({ ...s, diagram, selectedIds: [node.id] });
    }

    case 'MOVE_NODE': {
      const diagram = {
        ...state.diagram,
        nodes: state.diagram.nodes.map((n) =>
          n.id === action.id ? { ...n, x: action.x, y: action.y } : n
        ),
      };
      return recompute({ ...state, diagram });
    }

    case 'ADD_EDGE': {
      if (action.source === action.target) return state;
      // Check for duplicate
      const exists = state.diagram.edges.some(
        (e) =>
          (e.source === action.source && e.target === action.target) ||
          (e.source === action.target && e.target === action.source)
      );
      if (exists) return state;

      const s = pushUndo(state);
      const edge: DiagramEdge = {
        id: generateId('e'),
        source: action.source,
        target: action.target,
        elementType: 'compression',
      };
      const diagram = {
        ...s.diagram,
        edges: [...s.diagram.edges, edge],
      };
      return recompute({ ...s, diagram, selectedIds: [edge.id], edgeStartNode: null });
    }

    case 'DELETE_ELEMENT': {
      const s = pushUndo(state);
      const isNode = s.diagram.nodes.some((n) => n.id === action.id);
      let diagram: DiagramData;
      if (isNode) {
        diagram = {
          nodes: s.diagram.nodes.filter((n) => n.id !== action.id),
          edges: s.diagram.edges.filter(
            (e) => e.source !== action.id && e.target !== action.id
          ),
        };
      } else {
        diagram = {
          ...s.diagram,
          edges: s.diagram.edges.filter((e) => e.id !== action.id),
        };
      }
      return recompute({ ...s, diagram, selectedIds: [] });
    }

    case 'SET_SUPPORT': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        nodes: s.diagram.nodes.map((n) =>
          n.id === action.id ? { ...n, support: action.support } : n
        ),
      };
      return recompute({ ...s, diagram });
    }

    case 'SET_EXTERNAL_FORCE': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        nodes: s.diagram.nodes.map((n) =>
          n.id === action.id
            ? { ...n, externalForce: { x: action.fx, y: action.fy } }
            : n
        ),
      };
      return recompute({ ...s, diagram });
    }

    case 'SET_ELEMENT_TYPE': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        edges: s.diagram.edges.map((e) =>
          e.id === action.id ? { ...e, elementType: action.elementType } : e
        ),
      };
      return recompute({ ...s, diagram });
    }

    case 'SELECT':
      return { ...state, selectedIds: action.ids };

    case 'SET_MODE':
      return { ...state, mode: action.mode, edgeStartNode: null, forceStartNode: null };

    case 'SET_EDGE_START':
      return { ...state, edgeStartNode: action.id };

    case 'SET_FORCE_START':
      return { ...state, forceStartNode: action.id };

    case 'UNDO': {
      if (state.undoStack.length === 0) return state;
      const undoStack = [...state.undoStack];
      const prev = undoStack.pop()!;
      const redoStack = [...state.redoStack, cloneDiagram(state.diagram)];
      return recompute({ ...state, diagram: prev, undoStack, redoStack, selectedIds: [] });
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state;
      const redoStack = [...state.redoStack];
      const next = redoStack.pop()!;
      const undoStack = [...state.undoStack, cloneDiagram(state.diagram)];
      return recompute({ ...state, diagram: next, undoStack, redoStack, selectedIds: [] });
    }

    case 'LOAD_STATE': {
      const s = pushUndo(state);
      return recompute({ ...s, diagram: cloneDiagram(action.data), selectedIds: [] });
    }

    case 'RECOMPUTE':
      return recompute(state);

    case 'PUSH_UNDO':
      return pushUndo(state);

    default:
      return state;
  }
}
