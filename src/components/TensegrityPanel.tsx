import React, { useMemo, useCallback } from 'react';
import { useAppState } from '../state/context';
import { validateTensegrity } from '../engine/tensegrity';
import { generateDXF, generateCutList } from '../export/dxf';

export function TensegrityPanel() {
  const { state } = useAppState();
  const { diagram } = state;

  const tensegrity = useMemo(() => validateTensegrity(diagram), [diagram]);

  const handleExportDXF = useCallback(() => {
    const dxf = generateDXF(diagram, tensegrity);
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tensegrity-plates.dxf';
    a.click();
    URL.revokeObjectURL(url);
  }, [diagram, tensegrity]);

  const handleExportCutList = useCallback(() => {
    const txt = generateCutList(tensegrity);
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tensegrity-cutlist.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [tensegrity]);

  const handleExportSVG = useCallback(() => {
    const svg = generateSVG(diagram, tensegrity);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tensegrity-plates.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [diagram, tensegrity]);

  return (
    <div className="tensegrity-panel">
      <h3>Tensegrity</h3>

      {/* Validation status */}
      <div className={`tensegrity-status ${tensegrity.isValid ? 'valid' : 'invalid'}`}>
        <span className="status-icon">{tensegrity.isValid ? '✓' : '✗'}</span>
        <span>{tensegrity.isValid ? 'Valid Tensegrity' : 'Not Valid'}</span>
      </div>

      <div className="tensegrity-counts">
        <span>Plates: {tensegrity.compressionCount}</span>
        <span>Cables: {tensegrity.tensionCount}</span>
      </div>

      {/* Issues */}
      {tensegrity.issues.length > 0 && (
        <div className="tensegrity-issues">
          {tensegrity.issues.map((issue, i) => (
            <div key={i} className="issue-item">{issue}</div>
          ))}
        </div>
      )}

      {/* Plates table */}
      {tensegrity.plates.length > 0 && (
        <div className="fab-section">
          <h4>Plates</h4>
          <div className="fab-table">
            {tensegrity.plates.map((plate) => (
              <div key={plate.edgeId} className="fab-row">
                <span className="fab-label">{plate.label}</span>
                <span className="fab-detail">
                  {(plate.length * 100).toFixed(0)}mm x {(plate.width * 100).toFixed(0)}mm
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cables table */}
      {tensegrity.cables.length > 0 && (
        <div className="fab-section">
          <h4>Cables</h4>
          <div className="fab-table">
            {tensegrity.cables.map((cable) => (
              <div key={cable.edgeId} className="fab-row">
                <span className="fab-label">{cable.label}</span>
                <span className="fab-detail">{(cable.length * 100).toFixed(0)}mm</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Export */}
      <div className="export-section">
        <h4>Export</h4>
        <div className="export-buttons">
          <button
            className="export-btn"
            onClick={handleExportDXF}
            disabled={tensegrity.plates.length === 0}
            title="Export plate outlines for laser cutting"
          >
            DXF (Laser Cut)
          </button>
          <button
            className="export-btn"
            onClick={handleExportSVG}
            disabled={tensegrity.plates.length === 0}
            title="Export as SVG"
          >
            SVG
          </button>
          <button
            className="export-btn"
            onClick={handleExportCutList}
            disabled={tensegrity.plates.length === 0 && tensegrity.cables.length === 0}
            title="Export cut list and assembly instructions"
          >
            Cut List
          </button>
        </div>
      </div>
    </div>
  );
}

/** Generate a simple SVG for plate visualization */
function generateSVG(
  diagram: import('../types').DiagramData,
  tensegrity: import('../types').TensegrityResult
): string {
  const SCALE = 100;
  const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));

  // Compute bounding box
  const allPoints: { x: number; y: number }[] = [];
  for (const plate of tensegrity.plates) {
    for (const c of plate.corners) allPoints.push(c);
  }
  for (const n of diagram.nodes) allPoints.push(n);
  if (allPoints.length === 0) return '<svg></svg>';

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs) - 0.5;
  const maxX = Math.max(...xs) + 0.5;
  const minY = Math.min(...ys) - 0.5;
  const maxY = Math.max(...ys) + 0.5;

  const w = (maxX - minX) * SCALE;
  const h = (maxY - minY) * SCALE;

  const toSVG = (x: number, y: number) =>
    `${((x - minX) * SCALE).toFixed(2)},${((maxY - y) * SCALE).toFixed(2)}`;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  parts.push('<style>');
  parts.push('.plate { fill: none; stroke: #333; stroke-width: 1; }');
  parts.push('.cable { fill: none; stroke: #1976d2; stroke-width: 0.5; stroke-dasharray: 4,2; }');
  parts.push('.center { fill: none; stroke: #d32f2f; stroke-width: 0.3; stroke-dasharray: 2,2; }');
  parts.push('.label { font-family: monospace; font-size: 8px; fill: #666; text-anchor: middle; }');
  parts.push('.hole { fill: none; stroke: #1976d2; stroke-width: 0.5; }');
  parts.push('</style>');

  // Plates
  for (const plate of tensegrity.plates) {
    const pts = plate.corners.map((c) => toSVG(c.x, c.y)).join(' ');
    parts.push(`<polygon class="plate" points="${pts}" />`);

    // Center line
    const edge = diagram.edges.find((e) => e.id === plate.edgeId);
    if (edge) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (src && tgt) {
        parts.push(`<line class="center" x1="${((src.x - minX) * SCALE).toFixed(2)}" y1="${((maxY - src.y) * SCALE).toFixed(2)}" x2="${((tgt.x - minX) * SCALE).toFixed(2)}" y2="${((maxY - tgt.y) * SCALE).toFixed(2)}" />`);
      }
    }

    // Label
    const cx = plate.corners.reduce((s, c) => s + c.x, 0) / 4;
    const cy = plate.corners.reduce((s, c) => s + c.y, 0) / 4;
    parts.push(`<text class="label" x="${((cx - minX) * SCALE).toFixed(2)}" y="${((maxY - cy) * SCALE).toFixed(2)}">${plate.label}</text>`);
  }

  // Cables
  for (const cable of tensegrity.cables) {
    const src = nodeMap.get(cable.sourceNodeId);
    const tgt = nodeMap.get(cable.targetNodeId);
    if (src && tgt) {
      parts.push(`<line class="cable" x1="${((src.x - minX) * SCALE).toFixed(2)}" y1="${((maxY - src.y) * SCALE).toFixed(2)}" x2="${((tgt.x - minX) * SCALE).toFixed(2)}" y2="${((maxY - tgt.y) * SCALE).toFixed(2)}" />`);
    }
  }

  // Holes
  for (const plate of tensegrity.plates) {
    const edge = diagram.edges.find((e) => e.id === plate.edgeId);
    if (!edge) continue;
    for (const nid of [edge.source, edge.target]) {
      const n = nodeMap.get(nid);
      if (n) {
        parts.push(`<circle class="hole" cx="${((n.x - minX) * SCALE).toFixed(2)}" cy="${((maxY - n.y) * SCALE).toFixed(2)}" r="1.5" />`);
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}
