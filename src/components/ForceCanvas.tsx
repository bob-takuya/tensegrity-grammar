import React, { useRef, useEffect, useState } from 'react';
import { useAppState } from '../state/context';
import { ForcePolygon, Vec2 } from '../types';

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

function worldToScreen(wx: number, wy: number, vt: ViewTransform): [number, number] {
  return [wx * vt.scale + vt.offsetX, -wy * vt.scale + vt.offsetY];
}

export function ForceCanvas() {
  const { state } = useAppState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 500 });
  const [vt, setVt] = useState<ViewTransform>({ offsetX: 200, offsetY: 250, scale: 80 });
  const [panning, setPanning] = useState(false);
  const [panStart, setPanStart] = useState<[number, number]>([0, 0]);

  const { forcePolygons, equilibrium, selectedIds } = state;

  // Resize
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

  // Auto-fit when polygons change
  useEffect(() => {
    if (forcePolygons.length === 0) return;
    // Collect all vertices from all polygons
    const allVerts: Vec2[] = [];
    for (const poly of forcePolygons) {
      for (const v of poly.vertices) {
        allVerts.push(v);
      }
    }
    if (allVerts.length === 0) return;

    const xs = allVerts.map((v) => v.x);
    const ys = allVerts.map((v) => v.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    const padding = 80;
    const scaleX = (size.w - padding * 2) / rangeX;
    const scaleY = (size.h - padding * 2) / rangeY;
    const newScale = Math.min(scaleX, scaleY, 200);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setVt({
      scale: newScale,
      offsetX: size.w / 2 - cx * newScale,
      offsetY: size.h / 2 + cy * newScale,
    });
  }, [forcePolygons, size]);

  // Pan & zoom
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1) {
      setPanning(true);
      setPanStart([e.clientX, e.clientY]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!panning) return;
    const dx = e.clientX - panStart[0];
    const dy = e.clientY - panStart[1];
    setVt((prev) => ({
      ...prev,
      offsetX: prev.offsetX + dx,
      offsetY: prev.offsetY + dy,
    }));
    setPanStart([e.clientX, e.clientY]);
  };

  const handleMouseUp = () => setPanning(false);

  const handleWheel = (e: React.WheelEvent) => {
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
  };

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
    ctx.fillStyle = '#f5f5f0';
    ctx.fillRect(0, 0, size.w, size.h);

    // Label
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('Force Diagram', 10, 18);

    if (forcePolygons.length === 0) {
      ctx.font = '13px sans-serif';
      ctx.fillStyle = '#aaa';
      ctx.textAlign = 'center';
      if (!equilibrium || equilibrium.status === 'no-structure') {
        ctx.fillText('Add nodes and edges to see the force diagram', size.w / 2, size.h / 2);
      } else if (equilibrium.status === 'unstable') {
        ctx.fillStyle = '#c62828';
        ctx.fillText('Structure is unstable — force diagram unavailable', size.w / 2, size.h / 2);
      } else if (equilibrium.status === 'indeterminate') {
        ctx.fillStyle = '#e65100';
        ctx.fillText('Structure is statically indeterminate', size.w / 2, size.h / 2);
      }
      return;
    }

    // Determine which polygons to draw prominently
    const selectedNodeIds = new Set(selectedIds);
    const hasSelectedNode = forcePolygons.some((p) => selectedNodeIds.has(p.nodeId));

    // Origin marker
    const [ox, oy] = worldToScreen(0, 0, vt);
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ox - 10, oy);
    ctx.lineTo(ox + 10, oy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy - 10);
    ctx.lineTo(ox, oy + 10);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw each force polygon
    for (const poly of forcePolygons) {
      const isSelected = selectedNodeIds.has(poly.nodeId);
      const isFaded = hasSelectedNode && !isSelected;
      const alpha = isFaded ? 0.15 : 1;

      drawForcePolygon(ctx, poly, vt, isSelected, alpha);
    }

    // Legend
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    const legendY = size.h - 45;
    ctx.fillStyle = '#1976d2';
    ctx.fillRect(10, legendY, 12, 3);
    ctx.fillStyle = '#666';
    ctx.fillText('Tension', 26, legendY + 4);
    ctx.fillStyle = '#d32f2f';
    ctx.fillRect(10, legendY + 12, 12, 3);
    ctx.fillStyle = '#666';
    ctx.fillText('Compression', 26, legendY + 16);
    ctx.fillStyle = '#9c27b0';
    ctx.fillRect(10, legendY + 24, 12, 3);
    ctx.fillStyle = '#666';
    ctx.fillText('External / Reaction', 26, legendY + 28);
  }, [forcePolygons, equilibrium, selectedIds, vt, size]);

  return (
    <div ref={containerRef} className="canvas-container">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: panning ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

function drawForcePolygon(
  ctx: CanvasRenderingContext2D,
  poly: ForcePolygon,
  vt: ViewTransform,
  isSelected: boolean,
  alpha: number
) {
  const { vertices, segments, closes } = poly;

  if (vertices.length < 2) return;

  // Draw filled polygon background (subtle)
  if (vertices.length >= 3) {
    ctx.beginPath();
    const [sx0, sy0] = worldToScreen(vertices[0].x, vertices[0].y, vt);
    ctx.moveTo(sx0, sy0);
    for (let i = 1; i < vertices.length; i++) {
      const [sx, sy] = worldToScreen(vertices[i].x, vertices[i].y, vt);
      ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    if (closes) {
      ctx.fillStyle = isSelected ? `rgba(76, 175, 80, ${0.08 * alpha})` : `rgba(200, 200, 200, ${0.05 * alpha})`;
    } else {
      ctx.fillStyle = `rgba(244, 67, 54, ${0.06 * alpha})`;
    }
    ctx.fill();
  }

  // Draw edges
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const v0 = vertices[i];
    const v1 = vertices[i + 1];
    const [sx0, sy0] = worldToScreen(v0.x, v0.y, vt);
    const [sx1, sy1] = worldToScreen(v1.x, v1.y, vt);

    // Color by type
    if (seg.type === 'member') {
      if (seg.force > 0.001) {
        ctx.strokeStyle = applyAlpha('#1976d2', alpha);
      } else if (seg.force < -0.001) {
        ctx.strokeStyle = applyAlpha('#d32f2f', alpha);
      } else {
        ctx.strokeStyle = applyAlpha('#999', alpha);
      }
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
    } else {
      ctx.strokeStyle = applyAlpha(seg.type === 'external' ? '#9c27b0' : '#00897b', alpha);
      ctx.lineWidth = isSelected ? 2.5 : 2;
      ctx.setLineDash(seg.type === 'reaction' ? [4, 3] : []);
    }

    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead at midpoint
    const mx = (sx0 + sx1) / 2;
    const my = (sy0 + sy1) / 2;
    const dx = sx1 - sx0;
    const dy = sy1 - sy0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 15) {
      const ux = dx / len;
      const uy = dy / len;
      const headLen = 5;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(mx + headLen * ux, my + headLen * uy);
      ctx.lineTo(
        mx - headLen * 0.6 * ux + headLen * 0.4 * uy,
        my - headLen * 0.6 * uy - headLen * 0.4 * ux
      );
      ctx.lineTo(
        mx - headLen * 0.6 * ux - headLen * 0.4 * uy,
        my - headLen * 0.6 * uy + headLen * 0.4 * ux
      );
      ctx.closePath();
      ctx.fill();
    }

    // Force magnitude label (only when selected or few polygons)
    if (isSelected && len > 25) {
      const labelX = mx + 8 * (dy / len || 0);
      const labelY = my - 8 * (dx / len || 0);
      ctx.font = '10px monospace';
      ctx.fillStyle = applyAlpha('#555', alpha);
      ctx.textAlign = 'center';
      const fMag = Math.sqrt(seg.dx * seg.dx + seg.dy * seg.dy);
      ctx.fillText(fMag.toFixed(2), labelX, labelY);
    }
  }

  // Draw vertices
  for (let i = 0; i < vertices.length; i++) {
    const [sx, sy] = worldToScreen(vertices[i].x, vertices[i].y, vt);
    ctx.beginPath();
    ctx.arc(sx, sy, isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = applyAlpha(i === 0 ? '#333' : '#666', alpha);
    ctx.fill();
  }

  // Residual gap line (if not closing)
  if (!closes && vertices.length >= 2) {
    const last = vertices[vertices.length - 1];
    const first = vertices[0];
    const [sx0, sy0] = worldToScreen(last.x, last.y, vt);
    const [sx1, sy1] = worldToScreen(first.x, first.y, vt);
    ctx.strokeStyle = `rgba(244, 67, 54, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function applyAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  // Convert hex to rgba
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}
