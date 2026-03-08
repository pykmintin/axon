import { useEffect, useRef, useCallback, useState } from 'react';
import type { MultiDirectedGraph } from 'graphology';
import circular from 'graphology-layout/circular';
import { useGraphStore } from '@/stores/graphStore';
import { useGraph } from '@/hooks/useGraph';
import { cn } from '@/lib/utils';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import type { Community } from '@/types';

/* ------------------------------------------------------------------ */
/*  Camera                                                             */
/* ------------------------------------------------------------------ */

interface Camera {
  x: number; // world-space offset x
  y: number; // world-space offset y
  zoom: number;
}

interface Point {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 10;
const ZOOM_SENSITIVITY = 0.001;
const ACTIVE_MOTION_THRESHOLD = 0.18;
const LAYOUT_SETTLE_FRAMES = 18;

function screenToWorld(
  sx: number,
  sy: number,
  cam: Camera,
  w: number,
  h: number,
): { x: number; y: number } {
  return {
    x: (sx - w / 2) / cam.zoom - cam.x,
    y: (sy - h / 2) / cam.zoom - cam.y,
  };
}

/* ------------------------------------------------------------------ */
/*  Node / edge appearance (replaces Sigma reducers)                   */
/* ------------------------------------------------------------------ */

interface VisualNode {
  id: string;
  x: number;
  y: number;
  size: number;
  color: string;
  borderColor: string;
  label: string;
  hidden: boolean;
  highlighted: boolean;
  zIndex: number;
  forceLabel: boolean;
  /** 0–1 spawn scale (nodes grow in during spawn animation) */
  spawnScale: number;
  /** 0–1 spawn alpha (nodes fade in during spawn animation) */
  spawnAlpha: number;
  /** 0–1 dim amount: 0 = full color, 1 = darkened shade of own color */
  dim: number;
  /** Label size scale: 1 = normal, <1 = smaller for connected-but-not-hovered nodes */
  labelScale: number;
}

interface VisualEdge {
  id: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  color: string;
  size: number;
  hidden: boolean;
  isArrow: boolean;
  /** Curvature offset for parallel edges. Set during visual computation. */
  curve: number;
  /** Radius of the target node — used to stop arrow at node edge */
  targetRadius: number;
  /** Radius of the source node */
  sourceRadius: number;
}

interface CommunityGroup {
  id: string;
  members: string[];
  radius: number;
}

function buildNeighborSet(graph: MultiDirectedGraph, nodeId: string | null): Set<string> | null {
  if (!nodeId) return null;
  const neighbors = new Set<string>();
  graph.forEachNeighbor(nodeId, (neighbor) => neighbors.add(neighbor));
  return neighbors;
}

function getAttr(attrs: Record<string, unknown>, key: string, fallback: string): string {
  const v = attrs[key];
  return typeof v === 'string' ? v : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function computeVisualNodes(
  graph: MultiDirectedGraph,
  state: {
    selectedNodeId: string | null;
    hoveredNodeId: string | null;
    selectedNeighbors: Set<string> | null;
    hoveredNeighbors: Set<string> | null;
    highlightedNodeIds: Set<string>;
    visibleNodeTypes: Set<string>;
  },
): VisualNode[] {
  const result: VisualNode[] = [];

  graph.forEachNode((id, attrs) => {
    const nodeType = (attrs.nodeType ?? '') as string;
    const node: VisualNode = {
      id,
      x: finiteOr(attrs.x, 0),
      y: finiteOr(attrs.y, 0),
      size: finiteOr(attrs.size, 3),
      color: attrs.color as string,
      borderColor: attrs.borderColor as string,
      label: (attrs.label as string) ?? '',
      hidden: false,
      highlighted: false,
      zIndex: 1,
      forceLabel: false,
      spawnScale: finiteOr(attrs._spawnScale, 1),
      spawnAlpha: finiteOr(attrs._spawnAlpha, 1),
      dim: 0,
      labelScale: 1,
    };

    if (!state.visibleNodeTypes.has(nodeType)) {
      node.hidden = true;
      result.push(node);
      return;
    }

    if (state.highlightedNodeIds.size > 0) {
      if (state.highlightedNodeIds.has(id)) {
        node.size *= 1.3;
        node.zIndex = 2;
      } else {
        node.dim = 1;
        node.zIndex = 0;
      }
      if (state.hoveredNodeId && id === state.hoveredNodeId) {
        node.highlighted = true;
        node.forceLabel = true;
      }
      result.push(node);
      return;
    }

    if (state.selectedNodeId && id !== state.selectedNodeId) {
      const isNeighbor = state.selectedNeighbors?.has(id) ?? false;
      if (!isNeighbor) {
        node.dim = 1;
        node.zIndex = 0;
      } else {
        node.forceLabel = true;
        node.zIndex = 2;
      }
    }

    if (state.selectedNodeId && id === state.selectedNodeId) {
      node.highlighted = true;
      node.forceLabel = true;
      node.zIndex = 3;
    }

    if (state.hoveredNodeId && !state.selectedNodeId) {
      if (id === state.hoveredNodeId) {
        node.color = getAttr(attrs, '_saturatedColor', node.color);
        node.borderColor = getAttr(attrs, '_saturatedBorder', node.borderColor);
        node.highlighted = true;
        node.forceLabel = true;
        node.zIndex = 3;
      } else {
        const isNeighbor = state.hoveredNeighbors?.has(id) ?? false;
        if (isNeighbor) {
          node.color = getAttr(attrs, '_saturatedColor', node.color);
          node.borderColor = getAttr(attrs, '_saturatedBorder', node.borderColor);
          node.forceLabel = true;
          node.labelScale = 0.45;
          node.zIndex = 2;
        } else {
          node.dim = 1;
          node.zIndex = 0;
        }
      }
    } else if (state.hoveredNodeId && id === state.hoveredNodeId) {
      node.color = getAttr(attrs, '_saturatedColor', node.color);
      node.borderColor = getAttr(attrs, '_saturatedBorder', node.borderColor);
      node.highlighted = true;
      node.forceLabel = true;
    }

    result.push(node);
  });

  result.sort((a, b) => a.zIndex - b.zIndex);
  return result;
}

function computeVisualEdges(
  graph: MultiDirectedGraph,
  state: {
    selectedNodeId: string | null;
    hoveredNodeId: string | null;
    highlightedNodeIds: Set<string>;
    visibleEdgeTypes: Set<string>;
    visibleNodeTypes: Set<string>;
  },
): VisualEdge[] {
  const result: VisualEdge[] = [];
  const nodeAttrs = new Map<string, { x: number; y: number; size: number; nodeType: string }>();
  graph.forEachNode((id, attrs) => {
    nodeAttrs.set(id, {
      x: finiteOr(attrs.x, 0),
      y: finiteOr(attrs.y, 0),
      size: finiteOr(attrs.size, 50),
      nodeType: (attrs.nodeType ?? '') as string,
    });
  });

  graph.forEachEdge((id, attrs, source, target) => {
    const edgeType = (attrs.edgeType ?? '') as string;
    const sourceAttrs = nodeAttrs.get(source);
    const targetAttrs = nodeAttrs.get(target);
    if (!sourceAttrs || !targetAttrs) return;
    const sourceNodeType = sourceAttrs.nodeType;
    const targetNodeType = targetAttrs.nodeType;

    const edge: VisualEdge = {
      id,
      sx: sourceAttrs.x as number,
      sy: sourceAttrs.y as number,
      tx: targetAttrs.x as number,
      ty: targetAttrs.y as number,
      color: (attrs.color as string) ?? '#2a3a4d',
      size: (attrs.size as number) ?? 0.6,
      hidden: false,
      isArrow: (attrs.type as string) === 'arrow',
      curve: 0,
      sourceRadius: (sourceAttrs.size as number) ?? 50,
      targetRadius: (targetAttrs.size as number) ?? 50,
    };

    if (!state.visibleEdgeTypes.has(edgeType)) {
      edge.hidden = true;
      result.push(edge);
      return;
    }

    if (!state.visibleNodeTypes.has(sourceNodeType) || !state.visibleNodeTypes.has(targetNodeType)) {
      edge.hidden = true;
      result.push(edge);
      return;
    }

    if (state.highlightedNodeIds.size > 0) {
      const sourceHighlighted = state.highlightedNodeIds.has(source);
      const targetHighlighted = state.highlightedNodeIds.has(target);
      if (sourceHighlighted || targetHighlighted) {
        edge.size = sourceHighlighted && targetHighlighted ? 5.0 : 3.4;
        edge.color = brightenEdgeColor(edge.color);
      } else {
        edge.hidden = true;
      }
      result.push(edge);
      return;
    }

    if (state.selectedNodeId) {
      if (source !== state.selectedNodeId && target !== state.selectedNodeId) {
        edge.hidden = true;
      } else {
        edge.size = 5.0;
        edge.color = brightenEdgeColor(edge.color);
      }
    }

    if (state.hoveredNodeId && !state.selectedNodeId) {
      if (source !== state.hoveredNodeId && target !== state.hoveredNodeId) {
        edge.hidden = true;
      } else {
        // Connected edge: much thicker, brighter, fully opaque
        edge.size = 5.0;
        edge.color = brightenEdgeColor(edge.color);
      }
    }

    result.push(edge);
  });

  // Assign curvature: all edges get a subtle curve, parallels fan out
  const pairSeen = new Map<string, number>();
  for (const edge of result) {
    if (edge.hidden) continue;
    // Group by rounded positions to detect parallel edges
    const k = `${Math.round(edge.sx)},${Math.round(edge.sy)}|${Math.round(edge.tx)},${Math.round(edge.ty)}`;
    const seenIdx = pairSeen.get(k) ?? 0;
    pairSeen.set(k, seenIdx + 1);

    const dist = Math.sqrt((edge.tx - edge.sx) ** 2 + (edge.ty - edge.sy) ** 2);
    const baseCurve = dist * 0.08;
    edge.curve = baseCurve + seenIdx * dist * 0.06;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Canvas rendering helpers                                           */
/* ------------------------------------------------------------------ */

const LABEL_FONT = "'JetBrains Mono', monospace";

/* ---- Bezier curved edges ---- */

function drawEdge(
  ctx: CanvasRenderingContext2D,
  e: VisualEdge,
  _zoom: number,
  vpMinX: number, vpMinY: number, vpMaxX: number, vpMaxY: number,
) {
  if (e.hidden) return;

  // Viewport cull: skip edges entirely outside the viewport
  const eMinX = Math.min(e.sx, e.tx) - Math.abs(e.curve);
  const eMaxX = Math.max(e.sx, e.tx) + Math.abs(e.curve);
  const eMinY = Math.min(e.sy, e.ty) - Math.abs(e.curve);
  const eMaxY = Math.max(e.sy, e.ty) + Math.abs(e.curve);
  if (eMaxX < vpMinX || eMinX > vpMaxX || eMaxY < vpMinY || eMinY > vpMaxY) return;

  const dx = e.tx - e.sx;
  const dy = e.ty - e.sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const px = -dy / len;
  const py = dx / len;

  const arrowLen = Math.max(12, e.size * 10);

  // Clip edge at node boundaries using direct geometric approach:
  // Walk along the straight source→target direction by the node radius.
  // This is fast, robust, and works for all edge lengths.
  const ux = dx / len;
  const uy = dy / len;

  // Start point: offset from source center along direction to target
  const startX = e.sx + ux * e.sourceRadius;
  const startY = e.sy + uy * e.sourceRadius;

  // End point: offset from target center back toward source
  const endPullback = e.targetRadius + (e.isArrow ? arrowLen : 0);
  const endX = e.tx - ux * endPullback;
  const endY = e.ty - uy * endPullback;

  // Skip if nodes are so close the clipped edge would be inverted
  const clippedDx = endX - startX;
  const clippedDy = endY - startY;
  if (clippedDx * dx + clippedDy * dy < 0) return; // dot product < 0 means inverted

  // Control point: project the original bezier control point
  // onto the clipped segment proportionally
  const clippedMx = (startX + endX) / 2 + px * e.curve;
  const clippedMy = (startY + endY) / 2 + py * e.curve;

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.quadraticCurveTo(clippedMx, clippedMy, endX, endY);
  ctx.strokeStyle = e.color;
  ctx.lineWidth = Math.max(0.8, e.size * 2);
  ctx.stroke();

  if (e.isArrow) {
    // Arrow direction: tangent at the end of the clipped curve
    // For the quadratic bezier, tangent at t=1 = 2*(end - control)
    const tdx = endX - clippedMx;
    const tdy = endY - clippedMy;
    const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
    if (tlen < 0.1) return;
    const aux = tdx / tlen;
    const auy = tdy / tlen;
    const arrowWidth = arrowLen * 0.5;
    const tipX = endX + aux * arrowLen;
    const tipY = endY + auy * arrowLen;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(endX - auy * arrowWidth, endY + aux * arrowWidth);
    ctx.lineTo(endX + auy * arrowWidth, endY - aux * arrowWidth);
    ctx.closePath();
    ctx.fillStyle = e.color;
    ctx.fill();
  }
}

/* ---- Nodes with glow ---- */

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: VisualNode,
  zoom: number,
  vpMinX: number, vpMinY: number, vpMaxX: number, vpMaxY: number,
) {
  if (n.hidden || n.spawnAlpha <= 0) return;
  const r = n.size * n.spawnScale;
  if (r < 0.5) return;

  // Viewport cull
  if (n.x + r < vpMinX || n.x - r > vpMaxX || n.y + r < vpMinY || n.y - r > vpMaxY) return;

  const screenR = r * zoom;
  ctx.globalAlpha = n.spawnAlpha * (1 - n.dim * 0.5);

  // Soft glow: only for non-dimmed nodes when they're large enough on screen to notice
  if (n.dim < 0.5 && screenR > 4) {
    const glowRadius = r * 1.8;
    const glow = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, glowRadius);
    glow.addColorStop(0, n.color + '30');
    glow.addColorStop(1, n.color + '00');
    ctx.beginPath();
    ctx.arc(n.x, n.y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
  }

  // Highlighted ring
  if (n.highlighted) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 4 / zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();
  }

  // Border circle
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.fillStyle = n.borderColor;
  ctx.fill();

  // Inner fill: use gradient only when large enough on screen, otherwise solid fill
  if (screenR > 8) {
    const inner = ctx.createRadialGradient(
      n.x - r * 0.2, n.y - r * 0.2, 0,
      n.x, n.y, r * 0.82,
    );
    inner.addColorStop(0, lighten(n.color, 30));
    inner.addColorStop(1, n.color);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 0.82, 0, Math.PI * 2);
    ctx.fillStyle = inner;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 0.82, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/** Brighten an rgba edge color: boost alpha to 0.9 and lighten RGB */
function brightenEdgeColor(color: string): string {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return color;
  const r = Math.min(255, parseInt(m[1]) + 60);
  const g = Math.min(255, parseInt(m[2]) + 60);
  const b = Math.min(255, parseInt(m[3]) + 60);
  return `rgba(${r},${g},${b},0.9)`;
}

/** Mix a hex color toward dark based on dim amount (0–1) */
function dimColor(hex: string, dim: number): string {
  if (dim <= 0 || !hex.startsWith('#') || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Target: very dark version of the same hue (15% brightness)
  const tr = Math.round(r * 0.15);
  const tg = Math.round(g * 0.15);
  const tb = Math.round(b * 0.15);
  const nr = Math.round(r + (tr - r) * dim);
  const ng = Math.round(g + (tg - g) * dim);
  const nb = Math.round(b + (tb - b) * dim);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

function lighten(hex: string, amount: number): string {
  // Handle rgba or non-hex gracefully
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/* ---- Labels with smooth fade ---- */

function drawLabel(
  ctx: CanvasRenderingContext2D,
  n: VisualNode,
  zoom: number,
  labelThreshold: number,
) {
  if (n.hidden || !n.label) return;

  const screenSize = n.size * zoom;
  // Smooth fade: fully invisible below threshold, fully visible at 2x threshold
  let labelAlpha: number;
  if (n.forceLabel) {
    labelAlpha = 1;
  } else if (screenSize < labelThreshold) {
    return;
  } else {
    labelAlpha = Math.min(1, (screenSize - labelThreshold) / labelThreshold);
  }

  const fontSize = (Math.max(10, Math.min(16, 8 + n.size * 0.5)) * n.labelScale) / zoom;
  ctx.font = `500 ${fontSize}px ${LABEL_FONT}`;

  const textX = n.x + n.size + 4 / zoom;
  const textY = n.y + fontSize * 0.35;

  // Halo
  ctx.globalAlpha = labelAlpha * 0.8;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3 / zoom;
  ctx.lineJoin = 'round';
  ctx.strokeText(n.label, textX, textY);

  // Text
  ctx.globalAlpha = labelAlpha;
  ctx.fillStyle = '#E6EDF3';
  ctx.fillText(n.label, textX, textY);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/*  Layout helpers (tree, radial — same as before)                     */
/* ------------------------------------------------------------------ */

type PositionMap = Map<string, { x: number; y: number }>;

function computeTreeLayout(graph: MultiDirectedGraph): PositionMap {
  const positions: PositionMap = new Map();
  const nodeIds: string[] = [];
  graph.forEachNode((id) => nodeIds.push(id));
  if (nodeIds.length === 0) return positions;

  let hubNode = nodeIds[0];
  let maxDeg = 0;
  for (const id of nodeIds) {
    const deg = graph.degree(id);
    if (deg > maxDeg) { maxDeg = deg; hubNode = id; }
  }

  const layers = new Map<string, number>();
  layers.set(hubNode, 0);
  const queue: string[] = [hubNode];
  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi];
    const depth = layers.get(current)!;
    graph.forEachNeighbor(current, (neighbor) => {
      if (!layers.has(neighbor)) { layers.set(neighbor, depth + 1); queue.push(neighbor); }
    });
  }

  const maxReachable = layers.size > 0 ? Math.max(...layers.values()) : 0;
  for (const id of nodeIds) {
    if (!layers.has(id)) layers.set(id, maxReachable + 1);
  }

  const layerGroups = new Map<number, string[]>();
  for (const [id, depth] of layers) {
    const group = layerGroups.get(depth) ?? [];
    group.push(id);
    layerGroups.set(depth, group);
  }

  for (const [, members] of layerGroups) {
    members.sort((a, b) => {
      const da = (graph.getNodeAttribute(a, 'directory') as string) ?? '';
      const db = (graph.getNodeAttribute(b, 'directory') as string) ?? '';
      return da.localeCompare(db);
    });
  }

  const maxLayer = Math.max(...layerGroups.keys());
  const LAYER_SPACING = 150;
  const widestCount = Math.max(...[...layerGroups.values()].map((g) => g.length));
  const nodeSpacing = Math.max(30, Math.min(80, 2400 / widestCount));

  for (const [depth, members] of layerGroups) {
    const y = depth * LAYER_SPACING;
    const totalWidth = (members.length - 1) * nodeSpacing;
    const startX = -totalWidth / 2;
    for (let i = 0; i < members.length; i++) {
      positions.set(members[i], { x: startX + i * nodeSpacing, y });
    }
  }

  if (maxLayer >= 0) {
    const centerY = (maxLayer * LAYER_SPACING) / 2;
    for (const [id, pos] of positions) {
      positions.set(id, { x: pos.x, y: pos.y - centerY });
    }
  }
  return positions;
}

function computeRadialLayout(graph: MultiDirectedGraph, centerNodeId?: string | null): PositionMap {
  const positions: PositionMap = new Map();
  const nodeIds: string[] = [];
  graph.forEachNode((id) => nodeIds.push(id));
  if (nodeIds.length === 0) return positions;

  let centerNode: string;
  if (centerNodeId && graph.hasNode(centerNodeId)) {
    centerNode = centerNodeId;
  } else {
    centerNode = nodeIds[0];
    let maxDegree = 0;
    for (const id of nodeIds) {
      const deg = graph.degree(id);
      if (deg > maxDegree) { maxDegree = deg; centerNode = id; }
    }
  }

  const ringMap = new Map<string, number>();
  ringMap.set(centerNode, 0);
  const queue: string[] = [centerNode];
  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi];
    const currentRing = ringMap.get(current)!;
    graph.forEachNeighbor(current, (neighbor) => {
      if (!ringMap.has(neighbor)) { ringMap.set(neighbor, currentRing + 1); queue.push(neighbor); }
    });
  }

  const ringGroups = new Map<number, string[]>();
  let maxRing = 0;
  for (const [id, ring] of ringMap) {
    const group = ringGroups.get(ring) ?? [];
    group.push(id);
    ringGroups.set(ring, group);
    if (ring > maxRing) maxRing = ring;
  }

  const orphans = nodeIds.filter((id) => !ringMap.has(id));
  if (orphans.length > 0) ringGroups.set(maxRing + 1, orphans);

  positions.set(centerNode, { x: 0, y: 0 });
  let prevRadius = 0;
  const sortedRings = [...ringGroups.keys()].filter((r) => r > 0).sort((a, b) => a - b);

  for (const ring of sortedRings) {
    const members = ringGroups.get(ring)!;
    const count = members.length;
    const circumferenceNeeded = count * 80;
    const radiusFromCount = circumferenceNeeded / (2 * Math.PI);
    const radius = Math.max(prevRadius + 150, radiusFromCount);
    prevRadius = radius;
    const arcStep = (2 * Math.PI) / count;
    const ringOffset = (ring % 2) * (arcStep / 2);
    for (let i = 0; i < count; i++) {
      const angle = ringOffset + arcStep * i;
      positions.set(members[i], { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  }
  return positions;
}

function estimateClusterRadius(graph: MultiDirectedGraph, members: string[]): number {
  if (members.length === 0) return 160;

  let totalArea = 0;
  let maxSize = 0;
  for (const memberId of members) {
    const size = finiteOr(graph.getNodeAttribute(memberId, 'size'), 50);
    maxSize = Math.max(maxSize, size);
    totalArea += Math.PI * Math.pow(size * 2.15, 2);
  }

  return Math.max(150, Math.sqrt(totalArea / Math.PI) + maxSize * 1.8);
}

function placeClusterCenters(groups: CommunityGroup[]): Map<string, Point> {
  const centers = new Map<string, Point>();
  const placed: { id: string; x: number; y: number; radius: number }[] = [];

  if (groups.length === 0) return centers;

  centers.set(groups[0].id, { x: 0, y: 0 });
  placed.push({ id: groups[0].id, x: 0, y: 0, radius: groups[0].radius });

  const GOLDEN_ANGLE = 2.399963229728653;
  for (let i = 1; i < groups.length; i++) {
    const group = groups[i];
    let step = i;
    let candidateX = 0;
    let candidateY = 0;

    while (true) {
      const spiralRadius = 140 + 36 * step + group.radius;
      const angle = step * GOLDEN_ANGLE;
      candidateX = Math.cos(angle) * spiralRadius;
      candidateY = Math.sin(angle) * spiralRadius;

      const overlaps = placed.some((existing) => {
        const dx = candidateX - existing.x;
        const dy = candidateY - existing.y;
        const minDistance = group.radius + existing.radius + 140;
        return dx * dx + dy * dy < minDistance * minDistance;
      });

      if (!overlaps) break;
      step += 1;
    }

    centers.set(group.id, { x: candidateX, y: candidateY });
    placed.push({ id: group.id, x: candidateX, y: candidateY, radius: group.radius });
  }

  return centers;
}

function computeClusterMemberLayout(
  graph: MultiDirectedGraph,
  center: Point,
  members: string[],
): PositionMap {
  const positions: PositionMap = new Map();
  if (members.length === 0) return positions;
  if (members.length === 1) {
    positions.set(members[0], center);
    return positions;
  }

  const memberSet = new Set(members);
  const sortedMembers = [...members].sort((a, b) => {
    let aInternalDegree = 0;
    graph.forEachNeighbor(a, (neighbor) => {
      if (memberSet.has(neighbor)) aInternalDegree += 1;
    });
    let bInternalDegree = 0;
    graph.forEachNeighbor(b, (neighbor) => {
      if (memberSet.has(neighbor)) bInternalDegree += 1;
    });

    return (
      bInternalDegree - aInternalDegree ||
      graph.degree(b) - graph.degree(a) ||
      a.localeCompare(b)
    );
  });

  positions.set(sortedMembers[0], center);
  if (sortedMembers.length === 2) {
    const offset = Math.max(
      finiteOr(graph.getNodeAttribute(sortedMembers[0], 'size'), 50),
      finiteOr(graph.getNodeAttribute(sortedMembers[1], 'size'), 50),
    ) * 2.8;
    positions.set(sortedMembers[1], { x: center.x + offset, y: center.y });
    return positions;
  }

  let index = 1;
  let ring = 1;
  while (index < sortedMembers.length) {
    const remaining = sortedMembers.length - index;
    const baseSpacing = 125 + ring * 18;
    const radius = ring * baseSpacing;
    const capacity = Math.max(6, Math.ceil((2 * Math.PI * radius) / 120));
    const count = Math.min(capacity, remaining);
    const angleStep = (2 * Math.PI) / count;
    const ringOffset = (ring % 2) * (angleStep / 2);

    for (let i = 0; i < count; i++) {
      const memberId = sortedMembers[index + i];
      const size = finiteOr(graph.getNodeAttribute(memberId, 'size'), 50);
      const angle = ringOffset + i * angleStep;
      const localRadius = radius + size * 0.35;
      positions.set(memberId, {
        x: center.x + Math.cos(angle) * localRadius,
        y: center.y + Math.sin(angle) * localRadius,
      });
    }

    index += count;
    ring += 1;
  }

  return positions;
}

function computeCommunityLayout(
  graph: MultiDirectedGraph,
  communities: Community[],
): PositionMap {
  const positions: PositionMap = new Map();
  const memberToCommunity = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const communityNameById = new Map<string, string>();

  for (const community of communities) {
    communityNameById.set(community.id, community.name);
    groups.set(community.id, []);
    for (const memberId of community.members) {
      memberToCommunity.set(memberId, community.id);
    }
  }

  graph.forEachNode((id, attrs) => {
    const fallbackGroup =
      memberToCommunity.get(id) ??
      (attrs.directory as string) ??
      (attrs.nodeType as string) ??
      'ungrouped';
    const members = groups.get(fallbackGroup) ?? [];
    members.push(id);
    groups.set(fallbackGroup, members);
  });

  const orderedGroups: CommunityGroup[] = [...groups.entries()]
    .filter(([, members]) => members.length > 0)
    .map(([groupId, members]) => ({
      id: groupId,
      members: [...members].sort(),
      radius: estimateClusterRadius(graph, members),
    }))
    .sort((a, b) => {
      const aName = communityNameById.get(a.id) ?? a.id;
      const bName = communityNameById.get(b.id) ?? b.id;
      return b.members.length - a.members.length || aName.localeCompare(bName);
    });

  if (orderedGroups.length === 0) {
    return computeRadialLayout(graph);
  }

  const clusterCenters = placeClusterCenters(orderedGroups);
  for (const group of orderedGroups) {
    const center = clusterCenters.get(group.id);
    if (!center) continue;
    const memberPositions = computeClusterMemberLayout(graph, center, group.members);
    for (const [memberId, point] of memberPositions) {
      positions.set(memberId, point);
    }
  }

  return positions;
}

function animatePositions(
  graph: MultiDirectedGraph,
  targets: PositionMap,
  duration: number,
  frameRef: React.MutableRefObject<number>,
  onComplete?: () => void,
  onFrame?: () => void,
): void {
  const starts: PositionMap = new Map();
  graph.forEachNode((id, attrs) => {
    starts.set(id, { x: attrs.x as number, y: attrs.y as number });
  });

  const t0 = performance.now();

  function tick() {
    const elapsed = performance.now() - t0;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);

    graph.forEachNode((id) => {
      const start = starts.get(id);
      const target = targets.get(id);
      if (!start || !target) return;
      const nextX = start.x + (target.x - start.x) * ease;
      const nextY = start.y + (target.y - start.y) * ease;
      graph.setNodeAttribute(id, 'x', Number.isFinite(nextX) ? nextX : start.x);
      graph.setNodeAttribute(id, 'y', Number.isFinite(nextY) ? nextY : start.y);
    });
    onFrame?.();

    if (progress < 1) {
      frameRef.current = requestAnimationFrame(tick);
    } else {
      onComplete?.();
    }
  }

  frameRef.current = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ */
/*  Hit testing                                                        */
/* ------------------------------------------------------------------ */

function findNodeAt(
  worldX: number,
  worldY: number,
  nodes: VisualNode[],
): string | null {
  // Iterate in reverse (highest zIndex drawn last = on top)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.hidden) continue;
    const dx = worldX - n.x;
    const dy = worldY - n.y;
    const hitRadius = n.size + 2; // small tolerance
    if (dx * dx + dy * dy <= hitRadius * hitRadius) {
      return n.id;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

interface GraphCanvasProps {
  className?: string;
}

export function GraphCanvas({ className }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const physicsRunning = useRef(true);
  const renderFrameRef = useRef<number>(0);
  const layoutAnimRef = useRef<number>(0);
  const nodesCache = useRef<VisualNode[]>([]);
  const edgesCache = useRef<VisualEdge[]>([]);
  const needsRender = useRef(true);
  const spawnAnimatingRef = useRef(false);
  const layoutAnimatingRef = useRef(false);
  const layoutActiveRef = useRef(true);
  const settleFramesRef = useRef(LAYOUT_SETTLE_FRAMES);
  const visualStateDirtyRef = useRef(true);
  const positionDirtyRef = useRef(true);
  const dimAnimatingRef = useRef(false);
  // Velocity arrays for friction-based physics (persistent across frames)
  const velocitiesRef = useRef<{ vx: Map<string, number>; vy: Map<string, number> }>({
    vx: new Map(), vy: new Map(),
  });
  // Per-node dim amount (0=normal, 1=fully dimmed) — lerped each frame for smooth transition
  const dimRef = useRef<Map<string, number>>(new Map());
  const [layoutActive, setLayoutActive] = useState(true);

  const { graphRef, loading, error } = useGraph();

  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const highlightedNodeIds = useGraphStore((s) => s.highlightedNodeIds);
  const visibleNodeTypes = useGraphStore((s) => s.visibleNodeTypes);
  const visibleEdgeTypes = useGraphStore((s) => s.visibleEdgeTypes);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setHoveredNode = useGraphStore((s) => s.setHoveredNode);
  const layoutMode = useGraphStore((s) => s.layoutMode);

  const setLayoutActivity = useCallback((next: boolean) => {
    if (layoutActiveRef.current !== next) {
      layoutActiveRef.current = next;
      setLayoutActive(next);
    }
  }, []);

  const markLayoutUnsettled = useCallback((frames = LAYOUT_SETTLE_FRAMES) => {
    settleFramesRef.current = frames;
    setLayoutActivity(true);
    needsRender.current = true;
  }, [setLayoutActivity]);

  // Mark for re-render when store state changes
  useEffect(() => {
    needsRender.current = true;
    visualStateDirtyRef.current = true;
  }, [selectedNodeId, highlightedNodeIds, visibleNodeTypes, visibleEdgeTypes]);

  /* ---------- render loop ---------- */

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const graph = graphRef.current;
    if (!canvas || !graph) {
      renderFrameRef.current = requestAnimationFrame(render);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      renderFrameRef.current = requestAnimationFrame(render);
      return;
    }

    const isAnimating =
      spawnAnimatingRef.current ||
      layoutAnimatingRef.current ||
      layoutActiveRef.current;
    if (!isAnimating && !needsRender.current) {
      renderFrameRef.current = requestAnimationFrame(render);
      return;
    }

    // Resize canvas to match CSS size (handles DPR)
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(width * dpr);
    const ch = Math.round(height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      needsRender.current = true;
    }

    // --- Custom physics ---
    // Skip physics entirely when all velocities are near zero (settled).
    // Wake up when a node is dragged or store state changes.
    //   • Soft overlap repulsion (rubber-band) adds extra push when nodes breach
    //     each other's personal space — proportional to overlap depth, no snap.
    //   • Heavy friction (0.92) bleeds velocity fast → nodes settle quickly.
    //   • Low max velocity cap → no explosions, smooth motion.
    //
    const g = graphRef.current;
    let motionMetric = 0;
    let collisionAdjusted = false;
    if (g && physicsRunning.current && layoutActiveRef.current) {
      positionDirtyRef.current = true;
      const vels = velocitiesRef.current;
      const ids: string[] = [];
      const xs: number[] = [];
      const ys: number[] = [];
      const rs: number[] = [];
      const fx: number[] = [];
      const fy: number[] = [];
      const isFixed: boolean[] = [];
      g.forEachNode((id, attrs) => {
        ids.push(id);
        xs.push(attrs.x as number);
        ys.push(attrs.y as number);
        rs.push((attrs.size as number) ?? 50);
        fx.push(0);
        fy.push(0);
        isFixed.push(!!(attrs.fixed));
        if (!vels.vx.has(id)) { vels.vx.set(id, 0); vels.vy.set(id, 0); }
      });
      const n = ids.length;
      const idIndex = new Map<string, number>();
      for (let i = 0; i < n; i++) idIndex.set(ids[i], i);

      // 1) Inverse gravity: force = GRAVITY * dist²  (toward center)
      //    At dist=100 → force ≈ 0.01, at dist=500 → force ≈ 0.25
      //    Essentially zero near center, only matters when drifting far.
      const GRAVITY = 0.000001;
      for (let i = 0; i < n; i++) {
        const distSq = xs[i] * xs[i] + ys[i] * ys[i];
        const dist = Math.sqrt(distSq);
        if (dist > 1) {
          // Force magnitude ∝ dist², direction toward center
          const strength = GRAVITY * distSq;
          fx[i] -= (xs[i] / dist) * strength;
          fy[i] -= (ys[i] / dist) * strength;
        }
      }

      // 2) Edge springs: pull connected nodes toward ideal distance
      const SPRING = 0.006;
      g.forEachEdge((_eid, _attrs, source, target) => {
        const si = idIndex.get(source);
        const ti = idIndex.get(target);
        if (si === undefined || ti === undefined) return;
        const dx = xs[ti] - xs[si];
        const dy = ys[ti] - ys[si];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idealDist = rs[si] + rs[ti] + 30;
        if (dist > 0.01) {
          const delta = (dist - idealDist) * SPRING;
          const ux = dx / dist;
          const uy = dy / dist;
          fx[si] += ux * delta;
          fy[si] += uy * delta;
          fx[ti] -= ux * delta;
          fy[ti] -= uy * delta;
        }
      });

      // 3) Coulomb repulsion + soft overlap (single O(n²) pass)
      const COULOMB = 800;
      const COULOMB_CUTOFF_SQ = 360000; // 600²
      const OVERLAP_STRENGTH = 0.5;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = xs[j] - xs[i];
          const dy = ys[j] - ys[i];
          const distSq = dx * dx + dy * dy;
          if (distSq > COULOMB_CUTOFF_SQ) continue;
          if (distSq < 0.01) {
            const angle = Math.random() * Math.PI * 2;
            fx[i] -= Math.cos(angle) * 2; fy[i] -= Math.sin(angle) * 2;
            fx[j] += Math.cos(angle) * 2; fy[j] += Math.sin(angle) * 2;
            continue;
          }
          const dist = Math.sqrt(distSq);
          const ux = dx / dist;
          const uy = dy / dist;
          // Coulomb
          const cForce = COULOMB / dist;
          if (!isFixed[i]) { fx[i] -= ux * cForce; fy[i] -= uy * cForce; }
          if (!isFixed[j]) { fx[j] += ux * cForce; fy[j] += uy * cForce; }
          // Soft overlap
          const md = 3 * rs[i] + 3 * rs[j];
          if (dist < md) {
            const oForce = OVERLAP_STRENGTH * (md - dist);
            if (!isFixed[i]) { fx[i] -= ux * oForce; fy[i] -= uy * oForce; }
            if (!isFixed[j]) { fx[j] += ux * oForce; fy[j] += uy * oForce; }
          }
        }
      }

      // Apply forces → velocity → position, with heavy friction
      const FRICTION = 0.08; // velocity retained = 1 - FRICTION = 0.92
      const MAX_VELOCITY = 6;
      let totalSpeed = 0;
      for (let i = 0; i < n; i++) {
        if (isFixed[i]) {
          vels.vx.set(ids[i], 0);
          vels.vy.set(ids[i], 0);
          continue;
        }
        // Accumulate force into velocity
        let nvx = vels.vx.get(ids[i])! + fx[i];
        let nvy = vels.vy.get(ids[i])! + fy[i];
        // Apply friction (drain velocity each frame)
        nvx *= (1 - FRICTION);
        nvy *= (1 - FRICTION);
        // Cap velocity
        const vmag = Math.sqrt(nvx * nvx + nvy * nvy);
        if (vmag > MAX_VELOCITY) {
          nvx = (nvx / vmag) * MAX_VELOCITY;
          nvy = (nvy / vmag) * MAX_VELOCITY;
        }
        vels.vx.set(ids[i], nvx);
        vels.vy.set(ids[i], nvy);
        totalSpeed += Math.sqrt(nvx * nvx + nvy * nvy);
        xs[i] += nvx;
        ys[i] += nvy;
      }

      // HARD CONSTRAINT: no two nodes closer than 3*r_i + 3*r_j.
      // Pre-compute 3*r for each node. Use distSq check before sqrt.
      // 2 passes (reduced from 4 — soft repulsion handles most cases now).
      const r3 = new Float64Array(n);
      for (let i = 0; i < n; i++) r3[i] = 3 * rs[i];
      const corrected = new Set<number>();
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = xs[j] - xs[i];
            const dy = ys[j] - ys[i];
            const md = r3[i] + r3[j];
            const distSq = dx * dx + dy * dy;
            if (distSq >= md * md) continue; // fast reject
            const dist = Math.sqrt(distSq);
            let ux: number, uy: number;
            if (dist < 0.01) {
              const angle = Math.random() * Math.PI * 2;
              ux = Math.cos(angle);
              uy = Math.sin(angle);
            } else {
              ux = dx / dist;
              uy = dy / dist;
            }
            const correction = (md - dist) / 2;
            if (!isFixed[i] && !isFixed[j]) {
              xs[i] -= ux * correction;
              ys[i] -= uy * correction;
              xs[j] += ux * correction;
              ys[j] += uy * correction;
              corrected.add(i);
              corrected.add(j);
              collisionAdjusted = true;
            } else if (!isFixed[i]) {
              xs[i] -= ux * correction * 2;
              ys[i] -= uy * correction * 2;
              corrected.add(i);
              collisionAdjusted = true;
            } else if (!isFixed[j]) {
              xs[j] += ux * correction * 2;
              ys[j] += uy * correction * 2;
              corrected.add(j);
              collisionAdjusted = true;
            }
          }
        }
      }

      // Write corrected positions & kill velocity only for nodes that were pushed
      for (let i = 0; i < n; i++) {
        if (!isFixed[i]) {
          g.setNodeAttribute(ids[i], 'x', xs[i]);
          g.setNodeAttribute(ids[i], 'y', ys[i]);
          if (corrected.has(i)) {
            vels.vx.set(ids[i], 0);
            vels.vy.set(ids[i], 0);
          }
        }
      }

      motionMetric = n > 0 ? totalSpeed / n : 0;
    }

    if (spawnAnimatingRef.current || layoutAnimatingRef.current) {
      settleFramesRef.current = LAYOUT_SETTLE_FRAMES;
      setLayoutActivity(true);
    } else if (physicsRunning.current) {
      if (collisionAdjusted || motionMetric > ACTIVE_MOTION_THRESHOLD) {
        settleFramesRef.current = LAYOUT_SETTLE_FRAMES;
        setLayoutActivity(true);
      } else if (settleFramesRef.current > 0) {
        settleFramesRef.current -= 1;
        setLayoutActivity(true);
      } else {
        setLayoutActivity(false);
      }
    } else {
      settleFramesRef.current = 0;
      setLayoutActivity(false);
    }

    const cam = cameraRef.current;
    const state = useGraphStore.getState();
    const shouldRecomputeVisuals =
      visualStateDirtyRef.current ||
      positionDirtyRef.current ||
      dimAnimatingRef.current;

    let visualNodes = nodesCache.current;
    let visualEdges = edgesCache.current;
    let dimAnimating = dimAnimatingRef.current;

    if (shouldRecomputeVisuals) {
      const selectedNeighbors = buildNeighborSet(graph, state.selectedNodeId);
      const hoveredNeighbors = buildNeighborSet(graph, state.hoveredNodeId);

      visualNodes = computeVisualNodes(graph, {
        selectedNodeId: state.selectedNodeId,
        hoveredNodeId: state.hoveredNodeId,
        selectedNeighbors,
        hoveredNeighbors,
        highlightedNodeIds: state.highlightedNodeIds,
        visibleNodeTypes: state.visibleNodeTypes,
      });
      visualEdges = computeVisualEdges(graph, {
        selectedNodeId: state.selectedNodeId,
        hoveredNodeId: state.hoveredNodeId,
        highlightedNodeIds: state.highlightedNodeIds,
        visibleEdgeTypes: state.visibleEdgeTypes,
        visibleNodeTypes: state.visibleNodeTypes,
      });

      const dimMap = dimRef.current;
      const DIM_SPEED = 0.05;
      dimAnimating = false;
      for (const node of visualNodes) {
        const current = dimMap.get(node.id) ?? 0;
        const target = node.dim;
        if (Math.abs(target - current) > 0.005) dimAnimating = true;
        const next = current + (target - current) * DIM_SPEED;
        const snapped = Math.abs(next - target) < 0.005 ? target : next;
        dimMap.set(node.id, snapped);
        node.dim = snapped;
        if (snapped > 0.01) {
          node.color = dimColor(node.color, snapped);
          node.borderColor = dimColor(node.borderColor, snapped);
          if (snapped > 0.5) node.label = '';
        }
      }

      nodesCache.current = visualNodes;
      edgesCache.current = visualEdges;
      visualStateDirtyRef.current = false;
      if (!layoutActiveRef.current && !spawnAnimatingRef.current && !layoutAnimatingRef.current) {
        positionDirtyRef.current = false;
      }
      dimAnimatingRef.current = dimAnimating;
    }

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Background (solid fill — avoids gradient creation every frame)
    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 0, cw, ch);

    // Apply camera: translate to center, then offset, then scale
    ctx.setTransform(
      cam.zoom * dpr,
      0,
      0,
      cam.zoom * dpr,
      (cw / 2) + cam.x * cam.zoom * dpr,
      (ch / 2) + cam.y * cam.zoom * dpr,
    );

    // Compute viewport bounds in world space (for culling)
    const halfW = (width / 2) / cam.zoom;
    const halfH = (height / 2) / cam.zoom;
    const vpMinX = -cam.x - halfW;
    const vpMaxX = -cam.x + halfW;
    const vpMinY = -cam.y - halfH;
    const vpMaxY = -cam.y + halfH;

    // Draw edges
    for (const edge of visualEdges) {
      drawEdge(ctx, edge, cam.zoom, vpMinX, vpMinY, vpMaxX, vpMaxY);
    }

    // Draw nodes
    for (const node of visualNodes) {
      drawNode(ctx, node, cam.zoom, vpMinX, vpMinY, vpMaxX, vpMaxY);
    }

    // Draw labels — only when zoomed in enough that nodes are large on screen
    const labelThreshold = 40;
    for (const node of visualNodes) {
      if (node.hidden) continue;
      // Viewport cull labels too
      if (node.x + node.size < vpMinX || node.x - node.size > vpMaxX ||
          node.y + node.size < vpMinY || node.y - node.size > vpMaxY) continue;
      drawLabel(ctx, node, cam.zoom, labelThreshold);
    }

    // Minimap
    if (state.minimapVisible) {
      drawMinimap(ctx, visualNodes, cam, cw, ch, dpr);
    }

    needsRender.current = dimAnimating;
    renderFrameRef.current = requestAnimationFrame(render);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- setup ---------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const graphVal = graphRef.current;
    if (!canvas || !graphVal || loading) return;
    // Local alias for closures (TS can't narrow ref.current into closures)
    const graph: MultiDirectedGraph = graphVal;

    // Start render loop
    renderFrameRef.current = requestAnimationFrame(render);

    // --- Spawn animation: ripple nodes outward ring by ring ---
    // Nodes start at (0,0), animate to _targetX/_targetY by ring depth.
    const maxRing = (() => {
      let mr = 0;
      graph.forEachNode((_id, attrs) => {
        const r = (attrs._ring as number) ?? 0;
        if (r > mr) mr = r;
      });
      return mr;
    })();

    const RING_DELAY = 150; // ms stagger between rings
    const RING_DURATION = 600; // ms for each ring to animate
    const totalSpawnTime = (maxRing + 1) * RING_DELAY + RING_DURATION;
    const spawnT0 = performance.now();

    function spawnTick() {
      const elapsed = performance.now() - spawnT0;

      graph.forEachNode((id, attrs) => {
        if (attrs.fixed) return;
        const ring = (attrs._ring as number) ?? 0;
        const tx = (attrs._targetX as number) ?? 0;
        const ty = (attrs._targetY as number) ?? 0;

        const ringStart = ring * RING_DELAY;
        const ringEnd = ringStart + RING_DURATION;

        if (elapsed < ringStart) {
          graph.setNodeAttribute(id, 'x', 0);
          graph.setNodeAttribute(id, 'y', 0);
          // Scale & opacity: invisible before spawn
          graph.setNodeAttribute(id, '_spawnScale', 0);
          graph.setNodeAttribute(id, '_spawnAlpha', 0);
        } else if (elapsed >= ringEnd) {
          graph.setNodeAttribute(id, 'x', tx);
          graph.setNodeAttribute(id, 'y', ty);
          graph.setNodeAttribute(id, '_spawnScale', 1);
          graph.setNodeAttribute(id, '_spawnAlpha', 1);
        } else {
          // Ease out with slight overshoot for elastic feel
          const t = (elapsed - ringStart) / RING_DURATION;
          const ease = 1 - Math.pow(1 - t, 3);
          // Slight overshoot on scale for a "pop" effect
          const scaleEase = t < 0.6
            ? (t / 0.6) * 1.08
            : 1.08 - 0.08 * ((t - 0.6) / 0.4);
          graph.setNodeAttribute(id, 'x', tx * ease);
          graph.setNodeAttribute(id, 'y', ty * ease);
          graph.setNodeAttribute(id, '_spawnScale', Math.min(1, scaleEase));
          graph.setNodeAttribute(id, '_spawnAlpha', Math.min(1, t * 2)); // fade in fast
        }
      });
      positionDirtyRef.current = true;
      needsRender.current = true;

      if (elapsed < totalSpawnTime) {
        layoutAnimRef.current = requestAnimationFrame(spawnTick);
      } else {
        spawnAnimatingRef.current = false;
        fitCameraToGraph(graph, canvas!, cameraRef);
        // Physics runs in render loop automatically
      }
    }

    spawnAnimatingRef.current = true;
    markLayoutUnsettled(24);
    positionDirtyRef.current = true;
    layoutAnimRef.current = requestAnimationFrame(spawnTick);

    // Fit camera to target bounds immediately so we see the whole animation
    const targetBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    graph.forEachNode((_id, attrs) => {
      const tx = (attrs._targetX as number) ?? 0;
      const ty = (attrs._targetY as number) ?? 0;
      if (tx < targetBounds.minX) targetBounds.minX = tx;
      if (tx > targetBounds.maxX) targetBounds.maxX = tx;
      if (ty < targetBounds.minY) targetBounds.minY = ty;
      if (ty > targetBounds.maxY) targetBounds.maxY = ty;
    });
    if (isFinite(targetBounds.minX)) {
      const rect = canvas.getBoundingClientRect();
      const gw = targetBounds.maxX - targetBounds.minX || 1;
      const gh = targetBounds.maxY - targetBounds.minY || 1;
      const pad = 80;
      const zoom = Math.min((rect.width - pad * 2) / gw, (rect.height - pad * 2) / gh, MAX_ZOOM);
      cameraRef.current.zoom = Math.max(MIN_ZOOM, zoom);
      cameraRef.current.x = -(targetBounds.minX + targetBounds.maxX) / 2;
      cameraRef.current.y = -(targetBounds.minY + targetBounds.maxY) / 2;
    }

    // Physics is handled in the render loop — no external layout supervisor needed

    // Mouse interaction
    let draggedNode: string | null = null;
    let isPanning = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let didDrag = false;
    const DRAG_THRESHOLD = 5;

    function getCanvasXY(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function canvasToWorld(sx: number, sy: number) {
      const cam = cameraRef.current;
      const rect = canvas!.getBoundingClientRect();
      return screenToWorld(sx, sy, cam, rect.width, rect.height);
    }

    function onMouseDown(e: MouseEvent) {
      const { x: sx, y: sy } = getCanvasXY(e);
      lastMouseX = sx;
      lastMouseY = sy;
      dragStartX = sx;
      dragStartY = sy;
      didDrag = false;

      const world = canvasToWorld(sx, sy);
      const hit = findNodeAt(world.x, world.y, nodesCache.current);

      if (hit) {
        draggedNode = hit;
        graph.setNodeAttribute(hit, 'fixed', true);
        canvas!.style.cursor = 'grabbing';
      } else {
        isPanning = true;
        canvas!.style.cursor = 'grabbing';
      }
    }

    function onMouseMove(e: MouseEvent) {
      const { x: sx, y: sy } = getCanvasXY(e);

      if (draggedNode) {
        didDrag = true;
        markLayoutUnsettled();
        visualStateDirtyRef.current = true;
        positionDirtyRef.current = true;
        const world = canvasToWorld(sx, sy);
        const prevX = graph.getNodeAttribute(draggedNode, 'x') as number;
        const prevY = graph.getNodeAttribute(draggedNode, 'y') as number;
        graph.setNodeAttribute(draggedNode, 'x', world.x);
        graph.setNodeAttribute(draggedNode, 'y', world.y);

        // Pull connected nodes along — edges act like threads.
        // Neighbors follow the drag movement but maintain their relative distance.
        // They get the same displacement scaled down by proximity (closer = more pull).
        const dragDx = world.x - prevX;
        const dragDy = world.y - prevY;
        const vels = velocitiesRef.current;
        graph.forEachNeighbor(draggedNode, (nb) => {
          if (graph.getNodeAttribute(nb, 'fixed')) return;
          const nbx = graph.getNodeAttribute(nb, 'x') as number;
          const nby = graph.getNodeAttribute(nb, 'y') as number;
          const dx = world.x - nbx;
          const dy = world.y - nby;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 1) return;
          // Pull factor: closer neighbors follow more, farther ones follow less
          const falloff = 1000 / (dist + 1000); // 1.0 at dist=0, 0.5 at dist=1000
          const pull = 0.7 * falloff;
          // Apply the drag displacement (not toward the node — just the movement delta)
          const nx = nbx + dragDx * pull;
          const ny = nby + dragDy * pull;
          graph.setNodeAttribute(nb, 'x', nx);
          graph.setNodeAttribute(nb, 'y', ny);
          // Velocity impulse for smooth follow-through
          vels.vx.set(nb, (vels.vx.get(nb) ?? 0) + dragDx * pull * 0.4);
          vels.vy.set(nb, (vels.vy.get(nb) ?? 0) + dragDy * pull * 0.4);
        });

        needsRender.current = true;
      } else if (isPanning) {
        didDrag = true;
        const cam = cameraRef.current;
        const dx = (sx - lastMouseX) / cam.zoom;
        const dy = (sy - lastMouseY) / cam.zoom;
        cam.x += dx;
        cam.y += dy;
        needsRender.current = true;
      } else {
        // Hover detection
        const world = canvasToWorld(sx, sy);
        const hit = findNodeAt(world.x, world.y, nodesCache.current);
        const current = useGraphStore.getState().hoveredNodeId;
        if (hit !== current) {
          setHoveredNode(hit);
          visualStateDirtyRef.current = true;
          canvas!.style.cursor = hit ? 'grab' : 'default';
          needsRender.current = true;
        }
      }

      lastMouseX = sx;
      lastMouseY = sy;
    }

    function onMouseUp(e: MouseEvent) {
      const { x: sx, y: sy } = getCanvasXY(e);
      const dx = Math.abs(sx - dragStartX);
      const dy = Math.abs(sy - dragStartY);

      if (draggedNode) {
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) {
          // Click, not drag — select and unpin
          selectNode(draggedNode);
          graph.removeNodeAttribute(draggedNode, 'fixed');
        }
        // If dragged, keep node pinned so layout respects placement
        draggedNode = null;
      } else if (isPanning) {
        if (!didDrag || (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD)) {
          // Clicked on background
          selectNode(null);
          useGraphStore.getState().setHighlightedNodes(new Set());
        }
        isPanning = false;
      }

      canvas!.style.cursor = 'default';
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const cam = cameraRef.current;
      const { x: sx, y: sy } = getCanvasXY(e);
      const rect = canvas!.getBoundingClientRect();

      // World position under cursor before zoom
      const worldBefore = screenToWorld(sx, sy, cam, rect.width, rect.height);

      // Apply zoom
      const delta = -e.deltaY * ZOOM_SENSITIVITY;
      const factor = 1 + delta;
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));

      // World position under cursor after zoom
      const worldAfter = screenToWorld(sx, sy, cam, rect.width, rect.height);

      // Adjust offset so cursor stays over same world point
      cam.x += worldAfter.x - worldBefore.x;
      cam.y += worldAfter.y - worldBefore.y;

      needsRender.current = true;
    }

    function onMouseLeave() {
      if (draggedNode) {
        graph.removeNodeAttribute(draggedNode, 'fixed');
        draggedNode = null;
      }
      isPanning = false;
      setHoveredNode(null);
      visualStateDirtyRef.current = true;
      canvas!.style.cursor = 'default';
    }

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', onMouseLeave);

    return () => {
      cancelAnimationFrame(renderFrameRef.current);
      cancelAnimationFrame(layoutAnimRef.current);
      spawnAnimatingRef.current = false;
      layoutAnimatingRef.current = false;
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [loading, markLayoutUnsettled, render, selectNode, setHoveredNode]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- layout mode changes ---------- */

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !canvasRef.current) return;

    cancelAnimationFrame(layoutAnimRef.current);
    needsRender.current = true;
    markLayoutUnsettled();
    visualStateDirtyRef.current = true;
    positionDirtyRef.current = true;

    if (layoutMode === 'force') {
      physicsRunning.current = true;
      layoutAnimatingRef.current = false;
      settleFramesRef.current = LAYOUT_SETTLE_FRAMES;
    } else {
      physicsRunning.current = false;

      let targets: PositionMap;

      if (layoutMode === 'tree') {
        targets = computeTreeLayout(graph);
      } else if (layoutMode === 'radial') {
        targets = computeRadialLayout(graph, selectedNodeId);
      } else if (layoutMode === 'community') {
        const communities = useGraphStore.getState().communities;
        targets = computeCommunityLayout(graph, communities);
      } else {
        const nodeCount = graph.order;
        const circularScale = Math.max(500, nodeCount * 2);
        circular.assign(graph, { scale: circularScale });
        targets = new Map();
        graph.forEachNode((id, attrs) => {
          targets.set(id, {
            x: finiteOr(attrs.x, 0),
            y: finiteOr(attrs.y, 0),
          });
        });
      }

      layoutAnimatingRef.current = true;
      animatePositions(
        graph,
        targets,
        500,
        layoutAnimRef,
        () => {
          layoutAnimatingRef.current = false;
          settleFramesRef.current = 0;
          setLayoutActivity(false);
          positionDirtyRef.current = true;
          if (canvasRef.current) {
            fitCameraToGraph(graph, canvasRef.current, cameraRef);
          }
          needsRender.current = true;
        },
        () => {
          needsRender.current = true;
        },
      );
    }
  }, [layoutMode, markLayoutUnsettled, selectedNodeId, setLayoutActivity]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- controls ---------- */

  const zoomIn = useCallback(() => {
    cameraRef.current.zoom = Math.min(MAX_ZOOM, cameraRef.current.zoom * 1.3);
    needsRender.current = true;
  }, []);

  const zoomOut = useCallback(() => {
    cameraRef.current.zoom = Math.max(MIN_ZOOM, cameraRef.current.zoom / 1.3);
    needsRender.current = true;
  }, []);

  const fitToScreen = useCallback(() => {
    const graph = graphRef.current;
    const canvas = canvasRef.current;
    if (graph && canvas) fitCameraToGraph(graph, canvas, cameraRef);
    markLayoutUnsettled(8);
    needsRender.current = true;
  }, [markLayoutUnsettled]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLayout = useCallback(() => {
    physicsRunning.current = !physicsRunning.current;
    if (physicsRunning.current) {
      markLayoutUnsettled();
    } else {
      settleFramesRef.current = 0;
      setLayoutActivity(false);
    }
    needsRender.current = true;
  }, [markLayoutUnsettled, setLayoutActivity]);

  /* ---------- early returns ---------- */

  const nodes = useGraphStore((s) => s.nodes);
  const graphEmpty = !loading && !error && nodes.length === 0;

  if (error) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}
        style={{ color: 'var(--danger)', fontFamily: LABEL_FONT, fontSize: 12 }}>
        Failed to load graph: {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <LoadingSpinner message="Loading graph..." />
      </div>
    );
  }
  if (graphEmpty) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <EmptyState message="No graph data. Run `axon index` first." />
      </div>
    );
  }

  return (
    <div className={cn('relative w-full h-full', className)}>
      <canvas ref={canvasRef} className="w-full h-full block" />
      <GraphControls
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFitToScreen={fitToScreen}
        onToggleLayout={toggleLayout}
        layoutRunning={physicsRunning.current}
      />
      {layoutActive && <LayoutIndicator />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Camera fitting                                                     */
/* ------------------------------------------------------------------ */

function fitCameraToGraph(
  graph: MultiDirectedGraph,
  canvas: HTMLCanvasElement,
  cameraRef: React.MutableRefObject<Camera>,
) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((_id, attrs) => {
    const x = attrs.x as number;
    const y = attrs.y as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });

  if (!isFinite(minX)) return;

  const rect = canvas.getBoundingClientRect();
  const graphW = maxX - minX || 1;
  const graphH = maxY - minY || 1;
  const padding = 60;
  const zoom = Math.min(
    (rect.width - padding * 2) / graphW,
    (rect.height - padding * 2) / graphH,
    MAX_ZOOM,
  );

  const cam = cameraRef.current;
  cam.zoom = Math.max(MIN_ZOOM, zoom);
  cam.x = -(minX + maxX) / 2;
  cam.y = -(minY + maxY) / 2;
}

/* ------------------------------------------------------------------ */
/*  Minimap (drawn directly on main canvas)                            */
/* ------------------------------------------------------------------ */

const MINIMAP_W = 160;
const MINIMAP_H = 120;
const MINIMAP_PAD = 8;

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  nodes: VisualNode[],
  cam: Camera,
  canvasW: number,
  canvasH: number,
  dpr: number,
) {
  // Reset transform to draw in screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = canvasW / dpr;
  const h = canvasH / dpr;
  const mx = w - MINIMAP_W - MINIMAP_PAD;
  const my = h - MINIMAP_H - MINIMAP_PAD;

  // Background
  ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
  ctx.fillRect(mx, my, MINIMAP_W, MINIMAP_H);
  ctx.strokeStyle = '#1e2a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx + 0.5, my + 0.5, MINIMAP_W - 1, MINIMAP_H - 1);

  // Find bounds of all visible nodes
  let nMinX = Infinity, nMaxX = -Infinity, nMinY = Infinity, nMaxY = -Infinity;
  for (const n of nodes) {
    if (n.hidden) continue;
    if (n.x < nMinX) nMinX = n.x;
    if (n.x > nMaxX) nMaxX = n.x;
    if (n.y < nMinY) nMinY = n.y;
    if (n.y > nMaxY) nMaxY = n.y;
  }
  if (!isFinite(nMinX)) return;

  const rangeX = nMaxX - nMinX || 1;
  const rangeY = nMaxY - nMinY || 1;
  const drawW = MINIMAP_W - 12;
  const drawH = MINIMAP_H - 12;

  // Draw node dots
  for (const n of nodes) {
    if (n.hidden) continue;
    const px = mx + 6 + ((n.x - nMinX) / rangeX) * drawW;
    const py = my + 6 + ((n.y - nMinY) / rangeY) * drawH;
    ctx.fillStyle = n.color;
    ctx.fillRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2);
  }

  // Viewport rectangle
  const vpLeft = (-cam.x) - (w / 2) / cam.zoom;
  const vpTop = (-cam.y) - (h / 2) / cam.zoom;
  const vpRight = (-cam.x) + (w / 2) / cam.zoom;
  const vpBottom = (-cam.y) + (h / 2) / cam.zoom;

  const rl = mx + 6 + ((vpLeft - nMinX) / rangeX) * drawW;
  const rt = my + 6 + ((vpTop - nMinY) / rangeY) * drawH;
  const rr = mx + 6 + ((vpRight - nMinX) / rangeX) * drawW;
  const rb = my + 6 + ((vpBottom - nMinY) / rangeY) * drawH;

  ctx.strokeStyle = '#39d353';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    Math.max(mx, rl),
    Math.max(my, rt),
    Math.min(mx + MINIMAP_W, rr) - Math.max(mx, rl),
    Math.min(my + MINIMAP_H, rb) - Math.max(my, rt),
  );
}

/* ------------------------------------------------------------------ */
/*  Controls                                                           */
/* ------------------------------------------------------------------ */

interface GraphControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  onToggleLayout: () => void;
  layoutRunning: boolean;
}

function GraphControls({
  onZoomIn, onZoomOut, onFitToScreen, onToggleLayout, layoutRunning,
}: GraphControlsProps) {
  return (
    <div className="absolute bottom-3 left-3 flex flex-col gap-1" style={{ zIndex: 10 }}>
      <ControlButton onClick={onZoomIn} title="Zoom in" aria-label="Zoom in"><PlusIcon /></ControlButton>
      <ControlButton onClick={onZoomOut} title="Zoom out" aria-label="Zoom out"><MinusIcon /></ControlButton>
      <ControlButton onClick={onFitToScreen} title="Fit to screen" aria-label="Fit to screen"><MaximizeIcon /></ControlButton>
      <ControlButton onClick={onToggleLayout} title={layoutRunning ? 'Pause layout' : 'Resume layout'} aria-label={layoutRunning ? 'Pause layout' : 'Resume layout'}>
        {layoutRunning ? <PauseIcon /> : <PlayIcon />}
      </ControlButton>
    </div>
  );
}

function ControlButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="flex items-center justify-center transition-colors"
      style={{
        width: 24, height: 24,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 2,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
      {...props}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="8" height="8" rx="0.5" />
      <line x1="4" y1="4" x2="4" y2="4.01" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" stroke="none">
      <polygon points="3,1.5 10,6 3,10.5" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" stroke="none">
      <rect x="2.5" y="2" width="2.5" height="8" rx="0.5" />
      <rect x="7" y="2" width="2.5" height="8" rx="0.5" />
    </svg>
  );
}

function LayoutIndicator() {
  return (
    <div style={{
      position: 'absolute', bottom: 120, left: 12,
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 2, padding: '3px 8px', zIndex: 10,
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: 'var(--accent)', animation: 'axon-pulse 1.4s ease-in-out infinite',
      }} />
      <span style={{
        fontFamily: LABEL_FONT, fontSize: 10, color: 'var(--text-secondary)',
      }}>
        Optimizing layout...
      </span>
      <style>{`
        @keyframes axon-pulse {
          0%, 100% { transform: scale(0.8); opacity: 0.5; }
          50%      { transform: scale(1.2); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
