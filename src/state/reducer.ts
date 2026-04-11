import {
  AppState,
  AppAction,
  DiagramData,
  DiagramNode,
  DiagramEdge,
  ForcePolygon,
} from '../types';
import { generateId } from '../utils/id';
import { computeEquilibrium } from '../engine/equilibrium';
import { buildHalfEdgeStructure } from '../engine/halfEdge';
import { constructForceDiagram, computeForcePolygons } from '../engine/forceDiagram';
import { presetRules } from '../grammar/presets';
import { createHistoryTree, addHistoryNode, navigateHistory } from '../grammar/history';
import { RuleMatch } from '../grammar/types';
import {
  ForceGrammarState,
  initForceGrammar,
  computeFeasibilityDomain,
  resolveForceAddNode,
  resolveForceConnect,
  autoExploreForceGrammar,
} from '../grammar/forceGrammar';

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
  let forcePolygons: ForcePolygon[] = [];

  if (equilibrium.status === 'determinate' && equilibrium.forces.size > 0) {
    try {
      const heStruct = buildHalfEdgeStructure(nodes, edges);
      forceDiagram = constructForceDiagram(nodes, edges, heStruct, equilibrium.forces);
    } catch {
      // Force diagram construction may fail for degenerate graphs
    }
    forcePolygons = computeForcePolygons(nodes, edges, equilibrium);
  }

  // Recompute rule matches if a rule is selected
  let ruleMatches = state.ruleMatches;
  if (state.selectedRuleId) {
    const rule = presetRules.find((r) => r.id === state.selectedRuleId);
    ruleMatches = rule ? rule.findMatches(state.diagram) : [];
  }

  return { ...state, equilibrium, forceDiagram, forcePolygons, ruleMatches };
}

function pushUndo(state: AppState): AppState {
  const undoStack = [...state.undoStack, cloneDiagram(state.diagram)];
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  return { ...state, undoStack, redoStack: [] };
}

export function createInitialState(diagram?: DiagramData): AppState {
  const d = diagram || { nodes: [], edges: [] };
  const state: AppState = {
    diagram: d,
    equilibrium: null,
    forceDiagram: null,
    forcePolygons: [],
    selectedIds: [],
    mode: 'select',
    edgeStartNode: null,
    forceStartNode: null,
    undoStack: [],
    redoStack: [],
    // Grammar
    selectedRuleId: null,
    ruleMatches: [],
    ruleParams: {},
    highlightedMatchIndex: null,
    historyTree: createHistoryTree(d),
    // Force grammar
    forceGrammar: { active: false, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: false },
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
        z: 0,
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
          n.id === action.id ? { ...n, x: action.x, y: action.y, z: action.z ?? n.z } : n
        ),
      };
      return recompute({ ...state, diagram });
    }

    case 'ADD_EDGE': {
      if (action.source === action.target) return state;
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
        plateWidth: 0.3,
        plateThickness: 3,
        plateAngle: 0,
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

    case 'SET_PLATE_WIDTH': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        edges: s.diagram.edges.map((e) =>
          e.id === action.id ? { ...e, plateWidth: action.width } : e
        ),
      };
      return recompute({ ...s, diagram });
    }

    case 'SET_PLATE_THICKNESS': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        edges: s.diagram.edges.map((e) =>
          e.id === action.id ? { ...e, plateThickness: action.thickness } : e
        ),
      };
      return recompute({ ...s, diagram });
    }

    case 'SET_PLATE_ANGLE': {
      const s = pushUndo(state);
      const diagram = {
        ...s.diagram,
        edges: s.diagram.edges.map((e) =>
          e.id === action.id ? { ...e, plateAngle: action.angle } : e
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

    // ─── Grammar Actions ───────────────────────────────────────────

    case 'SELECT_RULE': {
      if (action.ruleId === null) {
        return { ...state, selectedRuleId: null, ruleMatches: [], ruleParams: {}, highlightedMatchIndex: null };
      }
      const rule = presetRules.find((r) => r.id === action.ruleId);
      if (!rule) return state;

      // Set default parameters
      const ruleParams: Record<string, number> = {};
      for (const p of rule.parameters) {
        ruleParams[p.key] = p.defaultValue;
      }
      const ruleMatches = rule.findMatches(state.diagram);
      return { ...state, selectedRuleId: action.ruleId, ruleMatches, ruleParams, highlightedMatchIndex: null };
    }

    case 'SET_RULE_PARAM': {
      const ruleParams = { ...state.ruleParams, [action.key]: action.value };
      return { ...state, ruleParams };
    }

    case 'HIGHLIGHT_MATCH':
      return { ...state, highlightedMatchIndex: action.index };

    case 'APPLY_RULE': {
      const rule = presetRules.find((r) => r.id === state.selectedRuleId);
      if (!rule) return state;
      const match = state.ruleMatches[action.matchIndex];
      if (!match) return state;

      const s = pushUndo(state);
      const newDiagram = rule.apply(s.diagram, match, s.ruleParams);

      // Update history tree
      let historyTree = s.historyTree || createHistoryTree(s.diagram);
      historyTree = addHistoryNode(historyTree, newDiagram, {
        ruleId: rule.id,
        ruleName: rule.name,
        matchLabel: match.label,
      });

      // Recompute matches for the same rule on the new diagram
      const newMatches = rule.findMatches(newDiagram);

      return recompute({
        ...s,
        diagram: newDiagram,
        ruleMatches: newMatches,
        highlightedMatchIndex: null,
        historyTree,
        selectedIds: [],
      });
    }

    case 'NAVIGATE_HISTORY': {
      if (!state.historyTree) return state;
      const targetNode = state.historyTree.nodes.get(action.historyId);
      if (!targetNode) return state;

      const s = pushUndo(state);
      const historyTree = navigateHistory(s.historyTree!, action.historyId);

      // Recompute matches
      let ruleMatches: RuleMatch[] = [];
      if (state.selectedRuleId) {
        const rule = presetRules.find((r) => r.id === state.selectedRuleId);
        if (rule) ruleMatches = rule.findMatches(targetNode.diagram);
      }

      return recompute({
        ...s,
        diagram: cloneDiagram(targetNode.diagram),
        historyTree,
        ruleMatches,
        highlightedMatchIndex: null,
        selectedIds: [],
      });
    }

    case 'AUTO_EXPLORE': {
      let currentState = state;
      const steps = Math.min(action.steps, 20);

      for (let i = 0; i < steps; i++) {
        // Pick a random rule
        const applicableRules = presetRules
          .filter((r) => r.category !== 'removal') // avoid removing edges during auto-explore
          .map((r) => ({ rule: r, matches: r.findMatches(currentState.diagram) }))
          .filter((rm) => rm.matches.length > 0);

        if (applicableRules.length === 0) break;

        const pick = applicableRules[Math.floor(Math.random() * applicableRules.length)];
        const matchIdx = Math.floor(Math.random() * pick.matches.length);
        const match = pick.matches[matchIdx];

        // Use default params with small random perturbation
        const params: Record<string, number> = {};
        for (const p of pick.rule.parameters) {
          const range = p.max - p.min;
          params[p.key] = p.defaultValue + (Math.random() - 0.5) * range * 0.3;
          params[p.key] = Math.max(p.min, Math.min(p.max, params[p.key]));
        }

        const newDiagram = pick.rule.apply(currentState.diagram, match, params);

        let historyTree = currentState.historyTree || createHistoryTree(currentState.diagram);
        historyTree = addHistoryNode(historyTree, newDiagram, {
          ruleId: pick.rule.id,
          ruleName: pick.rule.name,
          matchLabel: match.label,
        });

        currentState = {
          ...currentState,
          diagram: newDiagram,
          historyTree,
        };
      }

      // Recompute matches
      let ruleMatches: RuleMatch[] = [];
      if (currentState.selectedRuleId) {
        const rule = presetRules.find((r) => r.id === currentState.selectedRuleId);
        if (rule) ruleMatches = rule.findMatches(currentState.diagram);
      }

      return recompute({
        ...pushUndo(state),
        diagram: currentState.diagram,
        historyTree: currentState.historyTree,
        ruleMatches,
        highlightedMatchIndex: null,
        selectedIds: [],
      });
    }

    // ─── Force-Based Grammar Actions ─────────────────────────────

    case 'START_FORCE_GRAMMAR': {
      const fg = initForceGrammar(state.diagram);
      return { ...state, forceGrammar: fg };
    }

    case 'STOP_FORCE_GRAMMAR': {
      return {
        ...state,
        forceGrammar: { active: false, interimForces: [], selectedForceId: null, feasibilityDomain: null, isComplete: false },
      };
    }

    case 'SELECT_INTERIM_FORCE': {
      if (!action.forceId) {
        return { ...state, forceGrammar: { ...state.forceGrammar, selectedForceId: null, feasibilityDomain: null } };
      }
      const force = state.forceGrammar.interimForces.find((f) => f.id === action.forceId);
      if (!force) return state;
      const domain = computeFeasibilityDomain(force, state.diagram);
      return {
        ...state,
        forceGrammar: { ...state.forceGrammar, selectedForceId: action.forceId, feasibilityDomain: domain },
      };
    }

    case 'RESOLVE_FORCE_ADD_NODE': {
      const s = pushUndo(state);
      const result = resolveForceAddNode(s.diagram, s.forceGrammar, action.forceId, action.x, action.y);
      return recompute({ ...s, diagram: result.diagram, forceGrammar: result.forceGrammar, selectedIds: [] });
    }

    case 'RESOLVE_FORCE_CONNECT': {
      const s = pushUndo(state);
      const result = resolveForceConnect(s.diagram, s.forceGrammar, action.forceId, action.targetNodeId);
      return recompute({ ...s, diagram: result.diagram, forceGrammar: result.forceGrammar, selectedIds: [] });
    }

    case 'FORCE_GRAMMAR_AUTO_EXPLORE': {
      if (!state.forceGrammar.active) return state;
      const s = pushUndo(state);
      const result = autoExploreForceGrammar(s.diagram, s.forceGrammar, action.steps);
      return recompute({ ...s, diagram: result.diagram, forceGrammar: result.forceGrammar, selectedIds: [] });
    }

    default:
      return state;
  }
}
