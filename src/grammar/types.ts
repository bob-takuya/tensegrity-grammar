/**
 * Grammar type definitions for Shape Grammar Engine (Phase 2).
 */

import { DiagramData, Vec2 } from '../types';

// ─── Rule Parameter ──────────────────────────────────────────────

export interface RuleParameter {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

// ─── Rule Match ──────────────────────────────────────────────────
// Represents a location in the form diagram where a rule's LHS pattern matches.

export interface RuleMatch {
  ruleId: string;
  nodeIds: string[];
  edgeIds: string[];
  position: Vec2;       // centroid of match (for highlighting)
  label: string;        // human-readable description
}

// ─── Grammar Rule ────────────────────────────────────────────────

export type RuleCategory =
  | 'subdivision'
  | 'branching'
  | 'extension'
  | 'triangulation'
  | 'removal';

export interface GrammarRule {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  icon: string;
  parameters: RuleParameter[];
  /** Find all locations where this rule can be applied */
  findMatches: (diagram: DiagramData) => RuleMatch[];
  /** Apply the rule at a specific match location */
  apply: (
    diagram: DiagramData,
    match: RuleMatch,
    params: Record<string, number>
  ) => DiagramData;
}

// ─── Derivation History ──────────────────────────────────────────

export interface HistoryNode {
  id: string;
  diagram: DiagramData;
  ruleApplied: {
    ruleId: string;
    ruleName: string;
    matchLabel: string;
  } | null;
  parentId: string | null;
  childIds: string[];
}

export interface HistoryTree {
  nodes: Map<string, HistoryNode>;
  rootId: string;
  currentId: string;
}
