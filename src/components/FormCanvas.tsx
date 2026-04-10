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

  const { diagram, mode, selectedIds, edgeStartNode, equilibrium } = state;

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

    // Edges
    for (const edge of diagram.edges) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const [sx1, sy1] = worldToScreen(src.x, src.y, vt);
      const [sx2, sy2] = worldToScreen(tgt.x, tgt.y, vt);
      const f = forces.get(edge.id);
      const isSelected = selectedIds.includes(edge.id);

      // Color by force
      if (f !== undefined && Math.abs(f) > 0.001) {
        if (f > 0) {
          ctx.strokeStyle = isSelected ? '#2196f3' : '#1976d2'; // tension = blue
        } else {
          ctx.strokeStyle = isSelected ? '#f44336' : '#d32f2f'; // compression = red
        }
        ctx.lineWidth = Math.min(6, 2 + Math.abs(f) * 0.5);
      } else {
        ctx.strokeStyle = isSelected ? '#ff9800' : '#555';
        ctx.lineWidth = 2;
      }

      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();

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
  }, [diagram, vt, selectedIds, mode, edgeStartNode, equilibrium, size]);

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
