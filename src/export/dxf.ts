/**
 * DXF export for laser cutting.
 *
 * Generates a DXF file with:
 * - Plate outlines (closed polylines on "PLATES" layer)
 * - Center lines / marking lines (on "MARKING" layer)
 * - Plate labels (on "LABELS" layer)
 * - Cable attachment holes (on "HOLES" layer)
 */

import { DiagramData, DiagramNode, TensegrityResult, PlateInfo, Vec2 } from '../types';
import { sub, add, scale, normalize, length } from '../engine/geometry';

/** Scale factor from world units to mm for DXF output */
const WORLD_TO_MM = 100;

export function generateDXF(
  diagram: DiagramData,
  tensegrity: TensegrityResult
): string {
  const lines: string[] = [];

  // Header
  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1014');
  lines.push('9', '$INSUNITS', '70', '4'); // mm
  lines.push('0', 'ENDSEC');

  // Tables (layers)
  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER');
  addLayer(lines, 'PLATES', 7);     // white
  addLayer(lines, 'MARKING', 1);    // red
  addLayer(lines, 'LABELS', 3);     // green
  addLayer(lines, 'HOLES', 5);      // blue
  addLayer(lines, 'CABLES', 4);     // cyan
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  // Entities
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));

  // Draw plates
  for (const plate of tensegrity.plates) {
    const edge = diagram.edges.find((e) => e.id === plate.edgeId);
    if (!edge) continue;
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;

    // Plate outline (closed polyline)
    const corners = plate.corners.map((c) => toMM(c));
    addClosedPolyline(lines, corners, 'PLATES');

    // Center line (marking)
    addLine(lines, toMM({ x: src.x, y: src.y }), toMM({ x: tgt.x, y: tgt.y }), 'MARKING');

    // Plate label at center
    const cx = (src.x + tgt.x) / 2;
    const cy = (src.y + tgt.y) / 2;
    addText(lines, toMM({ x: cx, y: cy }), plate.label, 3, 'LABELS');

    // Cable attachment holes at endpoints
    const holeRadius = 1.5; // 1.5mm radius
    addCircle(lines, toMM({ x: src.x, y: src.y }), holeRadius, 'HOLES');
    addCircle(lines, toMM({ x: tgt.x, y: tgt.y }), holeRadius, 'HOLES');
  }

  // Draw cables (as reference lines, not for cutting)
  for (const cable of tensegrity.cables) {
    const src = nodeMap.get(cable.sourceNodeId);
    const tgt = nodeMap.get(cable.targetNodeId);
    if (!src || !tgt) continue;
    addLine(lines, toMM({ x: src.x, y: src.y }), toMM({ x: tgt.x, y: tgt.y }), 'CABLES');
  }

  lines.push('0', 'ENDSEC');
  lines.push('0', 'EOF');

  return lines.join('\n');
}

/** Generate a fabrication summary as text */
export function generateCutList(
  tensegrity: TensegrityResult
): string {
  const lines: string[] = [];
  lines.push('=== TENSEGRITY FABRICATION CUT LIST ===');
  lines.push('');

  lines.push('--- PLATES (Compression Members) ---');
  lines.push(`Count: ${tensegrity.plates.length}`);
  lines.push('');
  lines.push('Label | Length (mm) | Width (mm) | Thickness (mm)');
  lines.push('------+-------------+------------+---------------');
  for (const plate of tensegrity.plates) {
    const len = (plate.length * WORLD_TO_MM).toFixed(1);
    const w = (plate.width * WORLD_TO_MM).toFixed(1);
    const t = plate.thickness.toFixed(1);
    lines.push(`${plate.label.padEnd(5)} | ${len.padStart(11)} | ${w.padStart(10)} | ${t.padStart(13)}`);
  }

  lines.push('');
  lines.push('--- CABLES (Tension Members) ---');
  lines.push(`Count: ${tensegrity.cables.length}`);
  lines.push('');
  lines.push('Label | Length (mm)');
  lines.push('------+------------');
  for (const cable of tensegrity.cables) {
    const len = (cable.length * WORLD_TO_MM).toFixed(1);
    lines.push(`${cable.label.padEnd(5)} | ${len.padStart(10)}`);
  }

  lines.push('');
  lines.push('--- ASSEMBLY ORDER ---');
  lines.push('1. Cut all plates according to outlines');
  lines.push('2. Drill cable attachment holes at marked positions');
  lines.push('3. Thread cables through plates');
  lines.push('4. Start from the base, attach cables to plates bottom-up');
  lines.push('5. Tension cables gradually, checking equilibrium');

  return lines.join('\n');
}

// ─── DXF Helpers ─────────────────────────────────────────────────

function toMM(p: Vec2): Vec2 {
  return { x: p.x * WORLD_TO_MM, y: p.y * WORLD_TO_MM };
}

function addLayer(lines: string[], name: string, color: number) {
  lines.push('0', 'LAYER', '2', name, '70', '0', '62', String(color));
}

function addLine(lines: string[], from: Vec2, to: Vec2, layer: string) {
  lines.push('0', 'LINE');
  lines.push('8', layer);
  lines.push('10', from.x.toFixed(4), '20', from.y.toFixed(4), '30', '0');
  lines.push('11', to.x.toFixed(4), '21', to.y.toFixed(4), '31', '0');
}

function addClosedPolyline(lines: string[], points: Vec2[], layer: string) {
  lines.push('0', 'LWPOLYLINE');
  lines.push('8', layer);
  lines.push('90', String(points.length));
  lines.push('70', '1'); // closed
  for (const p of points) {
    lines.push('10', p.x.toFixed(4), '20', p.y.toFixed(4));
  }
}

function addCircle(lines: string[], center: Vec2, radius: number, layer: string) {
  lines.push('0', 'CIRCLE');
  lines.push('8', layer);
  lines.push('10', center.x.toFixed(4), '20', center.y.toFixed(4), '30', '0');
  lines.push('40', radius.toFixed(4));
}

function addText(lines: string[], pos: Vec2, text: string, height: number, layer: string) {
  lines.push('0', 'TEXT');
  lines.push('8', layer);
  lines.push('10', pos.x.toFixed(4), '20', pos.y.toFixed(4), '30', '0');
  lines.push('40', height.toFixed(4));
  lines.push('1', text);
  lines.push('72', '1'); // center justify
}
