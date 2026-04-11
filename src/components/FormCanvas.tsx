import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useAppState } from '../state/context';
import { DiagramNode, DiagramEdge, Vec2 } from '../types';
import { dist, pointToSegmentDist, snapToGrid } from '../engine/geometry';

const NODE_RADIUS = 6;
const HIT_RADIUS = 12;
const EDGE_HIT_DIST = 8;
const GRID_SIZE = 0.5;
const SUPPORT_SIZE = 14;
const FORCE_ARROW_SCALE = 30; // pixels per unit force

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

function worldToScreen(wx: number, wy: number, vt: ViewTransform): [number, number] {
  return [wx * vt.scale + vt.offsetX, -wy * vt.scale + vt.offsetY];
}

function screenToWorld(sx: number, sy: number, vt: ViewTransform): [number, number] {
  return [(sx - vt.offsetX) / vt.scale, -(sy - vt.offsetY) / vt.scale];
}

export function FormCanvas() {
  const { state, dispatch } = useAppState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [vt, setVt] = useState<ViewTransform>({ offsetX: 200, offsetY: 250, scale: 80 });
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [panStart, setPanStart] = useState<[number, number]>([0, 0]);
  const [dragMoved, setDragMoved] = useState(false);
  const [size, setSize] = useState({ w: 600, h: 500 });

  const { diagram, mode, selectedIds, edgeStartNode, equilibrium, ruleMatches, highlightedMatchIndex, forceGrammar } = state;

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Hit testing
  const hitTestNode = useCallback(
    (sx: number, sy: number): DiagramNode | null => {
      const [wx, wy] = screenToWorld(sx, sy, vt);
      for (let i = diagram.nodes.length - 1; i >= 0; i--) {
        const n = diagram.nodes[i];
        if (dist({ x: wx, y: wy }, { x: n.x, y: n.y }) < HIT_RADIUS / vt.scale) {
          return n;
        }
      }
      return null;
    },
    [diagram.nodes, vt]
  );

  const hitTestEdge = useCallback(
    (sx: number, sy: number): DiagramEdge | null => {
      const [wx, wy] = screenToWorld(sx, sy, vt);
      const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
      for (let i = diagram.edges.length - 1; i >= 0; i--) {
        const e = diagram.edges[i];
        const src = nodeMap.get(e.source);
        const tgt = nodeMap.get(e.target);
        if (!src || !tgt) continue;
        const d = pointToSegmentDist(
          { x: wx, y: wy },
          { x: src.x, y: src.y },
          { x: tgt.x, y: tgt.y }
        );
        if (d < EDGE_HIT_DIST / vt.scale) return e;
      }
      return null;
    },
    [diagram, vt]
  );

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Middle button or space: pan
      if (e.button === 1) {
        e.preventDefault();
        setPanning(true);
        setPanStart([e.clientX, e.clientY]);
        return;
      }

      if (e.button !== 0) return;

      const node = hitTestNode(sx, sy);
      const edge = !node ? hitTestEdge(sx, sy) : null;

      switch (mode) {
        case 'select':
          // Force grammar mode: clicking places a node to resolve the selected interim force
          if (forceGrammar.active && forceGrammar.selectedForceId && !node) {
            const [wx, wy] = screenToWorld(sx, sy, vt);
            const snapped = snapToGrid({ x: wx, y: wy }, GRID_SIZE);
            dispatch({
              type: 'RESOLVE_FORCE_ADD_NODE',
              forceId: forceGrammar.selectedForceId,
              x: snapped.x,
              y: snapped.y,
            });
            break;
          }
          // Force grammar: clicking an existing node connects to resolve
          if (forceGrammar.active && forceGrammar.selectedForceId && node) {
            dispatch({
              type: 'RESOLVE_FORCE_CONNECT',
              forceId: forceGrammar.selectedForceId,
              targetNodeId: node.id,
            });
            break;
          }
          if (node) {
            dispatch({ type: 'PUSH_UNDO' });
            dispatch({ type: 'SELECT', ids: [node.id] });
            setDragging(node.id);
            setDragMoved(false);
          } else if (edge) {
            dispatch({ type: 'SELECT', ids: [edge.id] });
          } else {
            dispatch({ type: 'SELECT', ids: [] });
            // Start panning
            setPanning(true);
            setPanStart([e.clientX, e.clientY]);
          }
          break;

        case 'addNode': {
          const [wx, wy] = screenToWorld(sx, sy, vt);
          const snapped = snapToGrid({ x: wx, y: wy }, GRID_SIZE);
          dispatch({ type: 'ADD_NODE', x: snapped.x, y: snapped.y });
          break;
        }

        case 'addEdge':
          if (node) {
            if (edgeStartNode === null) {
              dispatch({ type: 'SET_EDGE_START', id: node.id });
            } else {
              dispatch({ type: 'ADD_EDGE', source: edgeStartNode, target: node.id });
            }
          }
          break;

        case 'addForce':
          if (node) {
            // Set a default downward force
            const currentFx = node.externalForce.x;
            const currentFy = node.externalForce.y;
            if (currentFx === 0 && currentFy === 0) {
              dispatch({ type: 'SET_EXTERNAL_FORCE', id: node.id, fx: 0, fy: -1 });
            } else {
              // Toggle off
              dispatch({ type: 'SET_EXTERNAL_FORCE', id: node.id, fx: 0, fy: 0 });
            }
            dispatch({ type: 'SELECT', ids: [node.id] });
          }
          break;

        case 'delete':
          if (node) {
            dispatch({ type: 'DELETE_ELEMENT', id: node.id });
          } else if (edge) {
            dispatch({ type: 'DELETE_ELEMENT', id: edge.id });
          }
          break;
      }
    },
    [mode, hitTestNode, hitTestEdge, edgeStartNode, dispatch, vt]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panning) {
        const dx = e.clientX - panStart[0];
        const dy = e.clientY - panStart[1];
        setVt((prev) => ({
          ...prev,
          offsetX: prev.offsetX + dx,
          offsetY: prev.offsetY + dy,
        }));
        setPanStart([e.clientX, e.clientY]);
        return;
      }

      if (dragging) {
        const rect = canvasRef.current!.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const [wx, wy] = screenToWorld(sx, sy, vt);
        const snapped = snapToGrid({ x: wx, y: wy }, GRID_SIZE);
        dispatch({ type: 'MOVE_NODE', id: dragging, x: snapped.x, y: snapped.y });
        setDragMoved(true);
      }
    },
    [panning, panStart, dragging, vt, dispatch]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (panning) {
        setPanning(false);
        return;
      }
      if (dragging && dragMoved) {
        // Push undo for the completed drag (the intermediate moves didn't push undo)
        // We handle this by pushing undo at the start of drag
      }
      setDragging(null);
      setDragMoved(false);
    },
    [panning, dragging, dragMoved]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = canvasRef.current!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setVt((prev) => {
        const newScale = Math.max(10, Math.min(500, prev.scale * factor));
        return {
          scale: newScale,
          offsetX: sx - (sx - prev.offsetX) * (newScale / prev.scale),
          offsetY: sy - (sy - prev.offsetY) * (newScale / prev.scale),
        };
      });
    },
    []
  );

  // Drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, size.w, size.h);

    // Grid
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 1;
    const gridWorld = GRID_SIZE;
    const [x0, y0] = screenToWorld(0, size.h, vt);
    const [x1, y1] = screenToWorld(size.w, 0, vt);
    const gx0 = Math.floor(x0 / gridWorld) * gridWorld;
    const gy0 = Math.floor(y0 / gridWorld) * gridWorld;
    for (let gx = gx0; gx <= x1; gx += gridWorld) {
      const [sx] = worldToScreen(gx, 0, vt);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, size.h);
      ctx.stroke();
    }
    for (let gy = gy0; gy <= y1; gy += gridWorld) {
      const [, sy] = worldToScreen(0, gy, vt);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(size.w, sy);
      ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1.5;
    const [ax] = worldToScreen(0, 0, vt);
    const [, ay] = worldToScreen(0, 0, vt);
    ctx.beginPath();
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, size.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, ay);
    ctx.lineTo(size.w, ay);
    ctx.stroke();

    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    const forces = equilibrium?.forces || new Map<string, number>();

    // Plate outlines (compression members with width > 0)
    for (const edge of diagram.edges) {
      if (edge.elementType !== 'compression' || edge.plateWidth <= 0) continue;
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-10) continue;
      const nx = -dy / len * edge.plateWidth / 2;
      const ny = dx / len * edge.plateWidth / 2;

      const corners = [
        worldToScreen(src.x + nx, src.y + ny, vt),
        worldToScreen(tgt.x + nx, tgt.y + ny, vt),
        worldToScreen(tgt.x - nx, tgt.y - ny, vt),
        worldToScreen(src.x - nx, src.y - ny, vt),
      ];

      const isSelected = selectedIds.includes(edge.id);
      ctx.beginPath();
      ctx.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
      ctx.closePath();
      ctx.fillStyle = isSelected ? 'rgba(255,152,0,0.1)' : 'rgba(211,47,47,0.06)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#ff9800' : 'rgba(211,47,47,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Edges
    for (const edge of diagram.edges) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const [sx1, sy1] = worldToScreen(src.x, src.y, vt);
      const [sx2, sy2] = worldToScreen(tgt.x, tgt.y, vt);
      const f = forces.get(edge.id);
      const isSelected = selectedIds.includes(edge.id);

      // Tension cables: dashed
      if (edge.elementType === 'tension') {
        ctx.setLineDash([6, 4]);
      }

      // Color by force
      if (f !== undefined && Math.abs(f) > 0.001) {
        if (f > 0) {
          ctx.strokeStyle = isSelected ? '#2196f3' : '#1976d2'; // tension = blue
        } else {
          ctx.strokeStyle = isSelected ? '#f44336' : '#d32f2f'; // compression = red
        }
        ctx.lineWidth = Math.min(6, 2 + Math.abs(f) * 0.5);
      } else {
        ctx.strokeStyle = isSelected ? '#ff9800' : (edge.elementType === 'tension' ? '#1976d2' : '#555');
        ctx.lineWidth = edge.elementType === 'tension' ? 1.5 : 2;
      }

      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Force label
      if (f !== undefined && Math.abs(f) > 0.001) {
        const mx = (sx1 + sx2) / 2;
        const my = (sy1 + sy2) / 2;
        ctx.font = '11px monospace';
        ctx.fillStyle = f > 0 ? '#1565c0' : '#c62828';
        ctx.textAlign = 'center';
        ctx.fillText(`${f > 0 ? 'T' : 'C'} ${Math.abs(f).toFixed(2)}`, mx, my - 6);
      }
    }

    // Edge-start indicator (addEdge mode)
    if (edgeStartNode) {
      const startNode = nodeMap.get(edgeStartNode);
      if (startNode) {
        const [sx, sy] = worldToScreen(startNode.x, startNode.y, vt);
        ctx.strokeStyle = '#4caf50';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, NODE_RADIUS + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Support symbols & external forces
    for (const node of diagram.nodes) {
      const [sx, sy] = worldToScreen(node.x, node.y, vt);

      // Support
      if (node.support === 'pin') {
        drawPinSupport(ctx, sx, sy, SUPPORT_SIZE);
      } else if (node.support === 'roller-x') {
        drawRollerSupport(ctx, sx, sy, SUPPORT_SIZE, false);
      } else if (node.support === 'roller-y') {
        drawRollerSupport(ctx, sx, sy, SUPPORT_SIZE, true);
      }

      // External force arrow
      const ef = node.externalForce;
      if (Math.abs(ef.x) > 0.001 || Math.abs(ef.y) > 0.001) {
        drawForceArrow(ctx, sx, sy, ef, FORCE_ARROW_SCALE);
      }

      // Reaction arrow
      if (equilibrium?.reactions) {
        const reaction = equilibrium.reactions.get(node.id);
        if (reaction && (Math.abs(reaction.x) > 0.001 || Math.abs(reaction.y) > 0.001)) {
          drawReactionArrow(ctx, sx, sy, reaction, FORCE_ARROW_SCALE);
        }
      }
    }

    // Nodes
    for (const node of diagram.nodes) {
      const [sx, sy] = worldToScreen(node.x, node.y, vt);
      const isSelected = selectedIds.includes(node.id);

      ctx.beginPath();
      ctx.arc(sx, sy, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#ff9800' : node.support !== 'free' ? '#4caf50' : '#333';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ─── Rule match highlights ──────────────────────────────────
    if (ruleMatches.length > 0) {
      for (let mi = 0; mi < ruleMatches.length; mi++) {
        const match = ruleMatches[mi];
        const isHighlighted = highlightedMatchIndex === mi;
        const alpha = isHighlighted ? 0.6 : 0.15;

        // Highlight matched edges
        for (const eid of match.edgeIds) {
          const edge = diagram.edges.find((e) => e.id === eid);
          if (!edge) continue;
          const src = nodeMap.get(edge.source);
          const tgt = nodeMap.get(edge.target);
          if (!src || !tgt) continue;
          const [sx1, sy1] = worldToScreen(src.x, src.y, vt);
          const [sx2, sy2] = worldToScreen(tgt.x, tgt.y, vt);
          ctx.strokeStyle = `rgba(255, 152, 0, ${alpha})`;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.stroke();
        }

        // Highlight matched nodes
        for (const nid of match.nodeIds) {
          const n = nodeMap.get(nid);
          if (!n) continue;
          const [sx, sy] = worldToScreen(n.x, n.y, vt);
          ctx.beginPath();
          ctx.arc(sx, sy, NODE_RADIUS + 5, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 152, 0, ${alpha})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Position marker for highlighted match
        if (isHighlighted) {
          const [mx, my] = worldToScreen(match.position.x, match.position.y, vt);
          ctx.beginPath();
          ctx.arc(mx, my, 10, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 152, 0, 0.3)';
          ctx.fill();
          ctx.strokeStyle = '#ff9800';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    // ─── Interim forces (force-based grammar) ─────────────────────
    if (forceGrammar.active && forceGrammar.interimForces.length > 0) {
      for (const iForce of forceGrammar.interimForces) {
        const node = nodeMap.get(iForce.nodeId);
        if (!node) continue;
        const [sx, sy] = worldToScreen(node.x, node.y, vt);
        const isSelected = forceGrammar.selectedForceId === iForce.id;
        const fMag = Math.sqrt(iForce.fx * iForce.fx + iForce.fy * iForce.fy);
        if (fMag < 0.01) continue;

        // Draw the interim force arrow (orange/yellow)
        const arrowLen = fMag * FORCE_ARROW_SCALE * 1.2;
        const dx = (iForce.fx / fMag) * arrowLen;
        const dy = -(iForce.fy / fMag) * arrowLen; // screen Y inverted
        const endX = sx + dx;
        const endY = sy + dy;

        ctx.strokeStyle = isSelected ? '#ff6f00' : '#ffa000';
        ctx.fillStyle = isSelected ? '#ff6f00' : '#ffa000';
        ctx.lineWidth = isSelected ? 3.5 : 2.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        // Arrowhead
        const ux = dx / arrowLen;
        const uy = dy / arrowLen;
        const hl = 10;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - hl * ux + hl * 0.4 * uy, endY - hl * uy - hl * 0.4 * ux);
        ctx.lineTo(endX - hl * ux - hl * 0.4 * uy, endY - hl * uy + hl * 0.4 * ux);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`IF ${fMag.toFixed(2)}`, endX, endY - 8);

        // Clickable indicator
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(sx, sy, NODE_RADIUS + 8, 0, Math.PI * 2);
          ctx.strokeStyle = '#ff6f00';
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Draw feasibility domain (line of action) for selected force
      if (forceGrammar.feasibilityDomain?.type === 'line' && forceGrammar.feasibilityDomain.origin && forceGrammar.feasibilityDomain.direction) {
        const { origin, direction } = forceGrammar.feasibilityDomain;
        // Draw a long dashed line through the origin in the force direction
        const ext = 20; // world units extent
        const [sx1, sy1] = worldToScreen(origin.x - direction.x * ext, origin.y - direction.y * ext, vt);
        const [sx2, sy2] = worldToScreen(origin.x + direction.x * ext, origin.y + direction.y * ext, vt);

        ctx.strokeStyle = 'rgba(255, 111, 0, 0.25)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        const [lx, ly] = worldToScreen(origin.x + direction.x * 3, origin.y + direction.y * 3, vt);
        ctx.font = '9px sans-serif';
        ctx.fillStyle = 'rgba(255, 111, 0, 0.6)';
        ctx.textAlign = 'left';
        ctx.fillText('Line of Action (optimal placement)', lx + 5, ly - 5);
      }

      // Completion status
      if (forceGrammar.isComplete) {
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = '#2e7d32';
        ctx.textAlign = 'center';
        ctx.fillText('✓ All interim forces resolved — equilibrium guaranteed', size.w / 2, 35);
      } else {
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#ff6f00';
        ctx.textAlign = 'center';
        ctx.fillText(
          `Force Grammar: ${forceGrammar.interimForces.length} interim force(s) remaining`,
          size.w / 2, 35
        );
      }
    }

    // Status indicator
    if (equilibrium) {
      const statusText =
        equilibrium.status === 'determinate'
          ? `Equilibrium ✓  (residual: ${equilibrium.residual.toExponential(1)})`
          : equilibrium.status === 'unstable'
          ? 'Unstable / Unbalanced ✗'
          : equilibrium.status === 'indeterminate'
          ? 'Statically Indeterminate'
          : '';
      ctx.font = '12px monospace';
      ctx.fillStyle = equilibrium.status === 'determinate' ? '#2e7d32' : '#c62828';
      ctx.textAlign = 'left';
      ctx.fillText(statusText, 10, size.h - 10);
    }

    // Mode indicator
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText(`Form Diagram — ${mode}`, 10, 18);
  }, [diagram, vt, selectedIds, mode, edgeStartNode, equilibrium, ruleMatches, highlightedMatchIndex, forceGrammar, size]);

  return (
    <div ref={containerRef} className="canvas-container">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: getCursor(mode) }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

function getCursor(mode: string): string {
  switch (mode) {
    case 'addNode': return 'crosshair';
    case 'addEdge': return 'crosshair';
    case 'addForce': return 'pointer';
    case 'delete': return 'not-allowed';
    default: return 'default';
  }
}

function drawPinSupport(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.strokeStyle = '#4caf50';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size / 2, y + size);
  ctx.lineTo(x + size / 2, y + size);
  ctx.closePath();
  ctx.stroke();
  // Ground line
  ctx.beginPath();
  ctx.moveTo(x - size * 0.6, y + size);
  ctx.lineTo(x + size * 0.6, y + size);
  ctx.stroke();
}

function drawRollerSupport(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  vertical: boolean
) {
  ctx.strokeStyle = '#4caf50';
  ctx.lineWidth = 1.5;

  if (!vertical) {
    // Roller on x-axis (vertical reaction)
    ctx.beginPath();
    ctx.arc(x, y + size * 0.7, size * 0.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - size * 0.6, y + size);
    ctx.lineTo(x + size * 0.6, y + size);
    ctx.stroke();
  } else {
    // Roller on y-axis (horizontal reaction)
    ctx.beginPath();
    ctx.arc(x + size * 0.7, y, size * 0.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + size, y - size * 0.6);
    ctx.lineTo(x + size, y + size * 0.6);
    ctx.stroke();
  }
}

function drawForceArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  force: Vec2,
  scale: number
) {
  const dx = force.x * scale;
  const dy = -force.y * scale; // screen Y is inverted
  const startX = x - dx;
  const startY = y - dy;

  ctx.strokeStyle = '#9c27b0';
  ctx.fillStyle = '#9c27b0';
  ctx.lineWidth = 2.5;

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(x, y);
  ctx.stroke();

  // Arrowhead
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 5) return;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 8;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - headLen * ux + headLen * 0.4 * uy, y - headLen * uy - headLen * 0.4 * ux);
  ctx.lineTo(x - headLen * ux - headLen * 0.4 * uy, y - headLen * uy + headLen * 0.4 * ux);
  ctx.closePath();
  ctx.fill();

  // Label
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    `(${force.x.toFixed(1)}, ${force.y.toFixed(1)})`,
    startX,
    startY - 6
  );
}

function drawReactionArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  reaction: Vec2,
  scale: number
) {
  const dx = reaction.x * scale;
  const dy = -reaction.y * scale;
  const endX = x + dx;
  const endY = y + dy;

  ctx.strokeStyle = '#00897b';
  ctx.fillStyle = '#00897b';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 5) return;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 7;
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(endX - headLen * ux + headLen * 0.4 * uy, endY - headLen * uy - headLen * 0.4 * ux);
  ctx.lineTo(endX - headLen * ux - headLen * 0.4 * uy, endY - headLen * uy + headLen * 0.4 * ux);
  ctx.closePath();
  ctx.fill();
}
