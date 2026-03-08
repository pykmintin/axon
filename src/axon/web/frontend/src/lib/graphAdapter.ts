import { MultiDirectedGraph } from 'graphology';
import type { GraphNode, GraphEdge, NodeLabel } from '@/types';

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

const NODE_COLORS: Record<string, { fill: string; border: string }> = {
  function:   { fill: '#39D353', border: '#56E06B' },  // GitHub green
  method:     { fill: '#58A6FF', border: '#79B8FF' },  // bright blue
  class:      { fill: '#F5A623', border: '#F7BC55' },  // warm amber
  interface:  { fill: '#00BCD4', border: '#33D1E6' },  // cyan
  type_alias: { fill: '#B455E0', border: '#C97AEA' },  // purple
  enum:       { fill: '#E85D75', border: '#EE8093' },  // rose-pink
  file:       { fill: '#8B949E', border: '#A0AAB4' },  // silver-grey
  folder:     { fill: '#D2A35C', border: '#DEBD7E' },  // warm tan
  community:  { fill: '#3FB950', border: '#5CC96A' },  // forest green
  process:    { fill: '#F78166', border: '#F9A08A' },  // coral-orange
};

const DEFAULT_NODE_FILL = '#4a5a6a';
const DEFAULT_NODE_BORDER = '#5a6a7a';
const DEFAULT_EDGE_COLOR = '#2a3a4d';

export const EDGE_STYLES: Record<string, { color: string; program: 'arrow' | 'rectangle' }> = {
  calls:            { color: 'rgba(100,180,255,0.4)', program: 'arrow' },
  imports:          { color: 'rgba(100,230,150,0.4)', program: 'arrow' },
  extends:          { color: 'rgba(255,170,80,0.45)', program: 'arrow' },
  implements:       { color: 'rgba(255,120,160,0.45)', program: 'arrow' },
  uses_type:        { color: 'rgba(180,140,255,0.4)', program: 'arrow' },
  coupled_with:     { color: 'rgba(255,100,100,0.35)', program: 'rectangle' },
  member_of:        { color: 'rgba(160,170,190,0.35)', program: 'rectangle' },
  step_in_process:  { color: 'rgba(80,220,190,0.4)', program: 'arrow' },
};

function desaturate(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const nr = Math.round(r + (gray - r) * amount);
  const ng = Math.round(g + (gray - g) * amount);
  const nb = Math.round(b + (gray - b) * amount);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/*  Organic graph-aware layout                                         */
/*                                                                     */
/*  1. Find hub (highest degree) → center                              */
/*  2. BFS to get placement order & depth (used for spawn stagger)     */
/*  3. Place each node near the centroid of its already-placed          */
/*     neighbors, with jitter for organic feel                          */
/*  4. Enforce hard minimum distance (3r_i + 3r_j) after each place    */
/*  5. Multiple relaxation passes to resolve all overlaps              */
/*  6. All nodes start at (0,0) with _targetX/_targetY for spawn       */
/* ------------------------------------------------------------------ */

function computeNodeSize(label: string, degree: number): number {
  const isClass = label === 'class' || label === 'interface';
  const base = isClass ? 80 : 50;
  return base + Math.min(60, Math.log(degree + 1) * 20);
}

/** Seeded PRNG for deterministic but organic-looking layouts */
function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeLayout(graph: MultiDirectedGraph): void {
  const nodeIds: string[] = [];
  graph.forEachNode((id) => nodeIds.push(id));
  if (nodeIds.length === 0) return;

  const rand = mulberry32(42);

  // Collect sizes
  const sizes = new Map<string, number>();
  for (const id of nodeIds) {
    sizes.set(id, graph.getNodeAttribute(id, 'size') as number);
  }

  // Find hub (highest degree)
  let hubId = nodeIds[0];
  let maxDeg = 0;
  for (const id of nodeIds) {
    const deg = graph.degree(id);
    if (deg > maxDeg) { maxDeg = deg; hubId = id; }
  }

  // BFS from hub — gives placement order and depth for spawn animation
  const depth = new Map<string, number>();
  const bfsOrder: string[] = [];
  depth.set(hubId, 0);
  const queue: string[] = [hubId];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    bfsOrder.push(cur);
    const d = depth.get(cur)!;
    graph.forEachNeighbor(cur, (nb) => {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    });
  }
  // Disconnected nodes go last
  const maxDepth = depth.size > 0 ? Math.max(...depth.values()) : 0;
  for (const id of nodeIds) {
    if (!depth.has(id)) {
      depth.set(id, maxDepth + 1);
      bfsOrder.push(id);
    }
  }

  // Golden-angle sunflower spiral: fills a circle with even area density.
  // Hub at center, BFS order so connected nodes get adjacent indices →
  // they land near each other on the spiral. Spacing scaled to respect
  // minimum distance (3r_i + 3r_j) from the start.
  const positions = new Map<string, { x: number; y: number }>();

  // Compute average node radius for spiral spacing
  let totalR = 0;
  for (const id of bfsOrder) totalR += sizes.get(id)!;
  const avgR = totalR / bfsOrder.length;
  // Spiral spacing: each node gets enough area to not overlap neighbors
  // Area per node ≈ π * (3r)² for the minimum distance circle
  const areaPerNode = Math.PI * (3 * avgR) * (3 * avgR);
  // Total area needed
  const totalArea = areaPerNode * bfsOrder.length;
  // Radius of the bounding circle
  const boundingR = Math.sqrt(totalArea / Math.PI);

  const GOLDEN_ANGLE = 2.399963229728653; // π * (3 - √5)

  for (let i = 0; i < bfsOrder.length; i++) {
    const id = bfsOrder[i];

    if (i === 0) {
      // Hub at center
      positions.set(id, { x: 0, y: 0 });
      continue;
    }

    // Sunflower spiral: radius proportional to sqrt(index), angle by golden ratio
    // This gives uniform area density across the circle
    const fraction = i / bfsOrder.length;
    const r = boundingR * Math.sqrt(fraction);
    const angle = i * GOLDEN_ANGLE;
    // Small random jitter for organic feel (±10% of position)
    const jitterR = 1 + (rand() - 0.5) * 0.2;
    const jitterA = (rand() - 0.5) * 0.3;

    positions.set(id, {
      x: r * jitterR * Math.cos(angle + jitterA),
      y: r * jitterR * Math.sin(angle + jitterA),
    });
  }

  // Pre-simulate: run the SAME physics as the live render loop offline
  // so nodes spawn already at their settled positions. This mirrors
  // GraphCanvas physics exactly: inverse gravity, edge springs, Coulomb
  // repulsion, soft overlap, and hard constraint.
  const allIds = [...positions.keys()];
  const xs = allIds.map((id) => positions.get(id)!.x);
  const ys = allIds.map((id) => positions.get(id)!.y);
  const rs = allIds.map((id) => sizes.get(id)!);
  const n = allIds.length;
  const idIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) idIndex.set(allIds[i], i);

  // Velocity arrays
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);

  // Same force model as GraphCanvas but with aggressive cooling schedule.
  // Optimized: reuse arrays, pre-compute constants, spatial grid for O(n²),
  // squared-distance checks before sqrt, early exit on convergence.
  const GRAVITY = 0.000001;
  const SPRING = 0.006;
  const COULOMB = 800;
  const COULOMB_CUTOFF = 600;
  const COULOMB_CUTOFF_SQ = COULOMB_CUTOFF * COULOMB_CUTOFF;
  const OVERLAP_STRENGTH = 0.5;
  const SIM_STEPS = 400;

  // Pre-cache edge list as flat typed array (2 ints per edge)
  const edgeBuf: number[] = [];
  graph.forEachEdge((_eid, _attrs, source, target) => {
    const si = idIndex.get(source);
    const ti = idIndex.get(target);
    if (si !== undefined && ti !== undefined) { edgeBuf.push(si, ti); }
  });
  const edges = new Int32Array(edgeBuf);
  const edgeCount = edges.length >> 1;

  // Pre-compute 3*r for each node (used in minDist = 3*r_i + 3*r_j)
  const r3 = new Float64Array(n);
  for (let i = 0; i < n; i++) r3[i] = 3 * rs[i];

  // Reusable force arrays (zero once, clear per step via .fill)
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  // Spatial grid for fast neighbor lookups in O(n²) loops
  const CELL_SIZE = COULOMB_CUTOFF;

  for (let step = 0; step < SIM_STEPS; step++) {
    const t = step / SIM_STEPS;
    const friction = 0.3 + t * 0.2;
    const maxVel = 12 * (1 - t * 0.7);

    fx.fill(0);
    fy.fill(0);

    // Inverse gravity
    for (let i = 0; i < n; i++) {
      const distSq = xs[i] * xs[i] + ys[i] * ys[i];
      if (distSq > 1) {
        const dist = Math.sqrt(distSq);
        const strength = GRAVITY * distSq;
        fx[i] -= (xs[i] / dist) * strength;
        fy[i] -= (ys[i] / dist) * strength;
      }
    }

    // Edge springs
    for (let e = 0; e < edgeCount; e++) {
      const si = edges[e * 2];
      const ti = edges[e * 2 + 1];
      const dx = xs[ti] - xs[si];
      const dy = ys[ti] - ys[si];
      const distSq = dx * dx + dy * dy;
      if (distSq < 0.0001) continue;
      const dist = Math.sqrt(distSq);
      const idealDist = rs[si] + rs[ti] + 30;
      const delta = (dist - idealDist) * SPRING;
      const ux = dx / dist;
      const uy = dy / dist;
      fx[si] += ux * delta;
      fy[si] += uy * delta;
      fx[ti] -= ux * delta;
      fy[ti] -= uy * delta;
    }

    // Build spatial grid for Coulomb + overlap (avoids checking all n² pairs)
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xs[i] / CELL_SIZE);
      const cy = Math.floor(ys[i] / CELL_SIZE);
      const key = cx * 73856093 + cy * 19349663; // hash
      const cell = grid.get(key);
      if (cell) cell.push(i); else grid.set(key, [i]);
    }

    // Coulomb repulsion + soft overlap — only check neighboring cells
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xs[i] / CELL_SIZE);
      const cy = Math.floor(ys[i] / CELL_SIZE);
      for (let dcx = -1; dcx <= 1; dcx++) {
        for (let dcy = -1; dcy <= 1; dcy++) {
          const key = (cx + dcx) * 73856093 + (cy + dcy) * 19349663;
          const cell = grid.get(key);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue; // each pair once
            const dx = xs[j] - xs[i];
            const dy = ys[j] - ys[i];
            const distSq = dx * dx + dy * dy;
            if (distSq > COULOMB_CUTOFF_SQ) continue;
            if (distSq < 0.01) {
              const angle = rand() * Math.PI * 2;
              fx[i] -= Math.cos(angle) * 2;
              fy[i] -= Math.sin(angle) * 2;
              fx[j] += Math.cos(angle) * 2;
              fy[j] += Math.sin(angle) * 2;
              continue;
            }
            const dist = Math.sqrt(distSq);
            const ux = dx / dist;
            const uy = dy / dist;
            // Coulomb
            const cForce = COULOMB / dist;
            fx[i] -= ux * cForce;
            fy[i] -= uy * cForce;
            fx[j] += ux * cForce;
            fy[j] += uy * cForce;
            // Soft overlap
            const md = r3[i] + r3[j];
            if (dist < md) {
              const oForce = OVERLAP_STRENGTH * (md - dist);
              fx[i] -= ux * oForce;
              fy[i] -= uy * oForce;
              fx[j] += ux * oForce;
              fy[j] += uy * oForce;
            }
          }
        }
      }
    }

    // Velocity integration with cooling friction
    let totalKE = 0;
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] + fx[i]) * (1 - friction);
      vy[i] = (vy[i] + fy[i]) * (1 - friction);
      const vmagSq = vx[i] * vx[i] + vy[i] * vy[i];
      if (vmagSq > maxVel * maxVel) {
        const vmag = Math.sqrt(vmagSq);
        vx[i] = (vx[i] / vmag) * maxVel;
        vy[i] = (vy[i] / vmag) * maxVel;
      }
      xs[i] += vx[i];
      ys[i] += vy[i];
      totalKE += vx[i] * vx[i] + vy[i] * vy[i];
    }

    // Hard constraint (2 passes, using spatial grid)
    for (let pass = 0; pass < 2; pass++) {
      // Rebuild grid for constraint pass (positions changed)
      const cGrid = new Map<number, number[]>();
      const cCell = CELL_SIZE * 0.5; // finer grid for overlap detection
      for (let i = 0; i < n; i++) {
        const gx = Math.floor(xs[i] / cCell);
        const gy = Math.floor(ys[i] / cCell);
        const key = gx * 73856093 + gy * 19349663;
        const cell = cGrid.get(key);
        if (cell) cell.push(i); else cGrid.set(key, [i]);
      }
      for (let i = 0; i < n; i++) {
        const gx = Math.floor(xs[i] / cCell);
        const gy = Math.floor(ys[i] / cCell);
        for (let dgx = -1; dgx <= 1; dgx++) {
          for (let dgy = -1; dgy <= 1; dgy++) {
            const key = (gx + dgx) * 73856093 + (gy + dgy) * 19349663;
            const cell = cGrid.get(key);
            if (!cell) continue;
            for (const j of cell) {
              if (j <= i) continue;
              const dx = xs[j] - xs[i];
              const dy = ys[j] - ys[i];
              const md = r3[i] + r3[j];
              const distSq = dx * dx + dy * dy;
              if (distSq >= md * md) continue;
              const dist = Math.sqrt(distSq);
              let ux: number, uy: number;
              if (dist < 0.01) {
                const angle = rand() * Math.PI * 2;
                ux = Math.cos(angle);
                uy = Math.sin(angle);
              } else {
                ux = dx / dist;
                uy = dy / dist;
              }
              const correction = (md - dist) / 2;
              xs[i] -= ux * correction;
              ys[i] -= uy * correction;
              xs[j] += ux * correction;
              ys[j] += uy * correction;
              vx[i] = 0; vy[i] = 0;
              vx[j] = 0; vy[j] = 0;
            }
          }
        }
      }
    }

    // Early exit when settled
    if (step > 50 && totalKE < 0.01 * n) break;
  }

  // Write final positions
  for (let i = 0; i < n; i++) {
    positions.set(allIds[i], { x: xs[i], y: ys[i] });
  }

  // Write to graph attributes
  graph.forEachNode((id) => {
    const pos = positions.get(id) ?? { x: 0, y: 0 };
    graph.setNodeAttribute(id, '_targetX', pos.x);
    graph.setNodeAttribute(id, '_targetY', pos.y);
    graph.setNodeAttribute(id, '_ring', depth.get(id) ?? 0);
    // Start at center for spawn animation
    graph.setNodeAttribute(id, 'x', 0);
    graph.setNodeAttribute(id, 'y', 0);
  });
}

/* ------------------------------------------------------------------ */
/*  Build graph                                                        */
/* ------------------------------------------------------------------ */

export function buildGraphology(nodes: GraphNode[], edges: GraphEdge[]): MultiDirectedGraph {
  const graph = new MultiDirectedGraph();

  // Add all nodes (positions computed after edges are added so we have degree info)
  for (const node of nodes) {
    const palette = NODE_COLORS[node.label] ?? { fill: DEFAULT_NODE_FILL, border: DEFAULT_NODE_BORDER };
    graph.addNode(node.id, {
      label: node.name,
      x: 0,
      y: 0,
      size: 3,
      color: palette.fill,
      borderColor: palette.border,
      nodeType: node.label as NodeLabel,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      signature: node.signature,
      language: node.language,
      className: node.className,
      isDead: node.isDead,
      isEntryPoint: node.isEntryPoint,
      isExported: node.isExported,
      directory: node.filePath ? node.filePath.split('/').slice(0, -1).join('/') : '',
    });
  }

  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    try {
      const style = EDGE_STYLES[edge.type] ?? { color: DEFAULT_EDGE_COLOR, program: 'rectangle' as const };
      graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
        edgeType: edge.type,
        type: style.program,
        color: style.color,
        size: 0.6,
        confidence: edge.confidence,
        strength: edge.strength,
        stepNumber: edge.stepNumber,
      });
    } catch { /* duplicate edge key */ }
  }

  // Compute sizes (needs degree from edges)
  graph.forEachNode((id, attrs) => {
    const degree = graph.degree(id);
    const nodeType = attrs.nodeType as string;
    const size = computeNodeSize(nodeType, degree);
    graph.setNodeAttribute(id, 'size', size);

    graph.setNodeAttribute(id, '_saturatedColor', attrs.color);
    graph.setNodeAttribute(id, '_saturatedBorder', attrs.borderColor);
    graph.setNodeAttribute(id, 'color', desaturate(attrs.color as string, 0.05));
    graph.setNodeAttribute(id, 'borderColor', desaturate(attrs.borderColor as string, 0.05));
  });

  // Compute organic layout positions (writes _targetX, _targetY, _ring)
  computeLayout(graph);

  return graph;
}