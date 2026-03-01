/**
 * WebGL-rendered graph canvas powered by Sigma.js v3 and Graphology.
 *
 * Initialises the Sigma renderer when the Graphology instance is ready,
 * applies the active layout (force / tree / radial), and wires up
 * selection, hover, type-based filtering, and the minimap overlay
 * through the Zustand graph store.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import Sigma from 'sigma';
import type { MultiDirectedGraph } from 'graphology';
import { createNodeBorderProgram } from '@sigma/node-border';
import FA2LayoutSupervisor from 'graphology-layout-forceatlas2/worker';
import { useGraphStore } from '@/stores/graphStore';
import { useGraph } from '@/hooks/useGraph';
import { cn } from '@/lib/utils';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { Minimap } from './Minimap';

interface GraphCanvasProps {
  className?: string;
}

// ---------------------------------------------------------------------------
// Layout algorithms
// ---------------------------------------------------------------------------

/** Position map: nodeId -> { x, y }. */
type PositionMap = Map<string, { x: number; y: number }>;

/**
 * Compute a hierarchical top-to-bottom tree layout.
 *
 * 1. Find root nodes (nodes with no incoming edges).
 * 2. Assign layers via BFS from roots.
 * 3. Space nodes evenly within each layer.
 */
function computeTreeLayout(graph: MultiDirectedGraph): PositionMap {
  const positions: PositionMap = new Map();
  const layers: Map<string, number> = new Map();
  const nodeIds: string[] = [];
  graph.forEachNode((id) => nodeIds.push(id));

  if (nodeIds.length === 0) return positions;

  // Find root nodes: nodes with in-degree 0.
  const roots: string[] = [];
  for (const id of nodeIds) {
    if (graph.inDegree(id) === 0) {
      roots.push(id);
    }
  }

  // If no roots found (cycles only), pick the node with highest out-degree.
  if (roots.length === 0) {
    let bestNode = nodeIds[0];
    let bestOut = 0;
    for (const id of nodeIds) {
      const out = graph.outDegree(id);
      if (out > bestOut) {
        bestOut = out;
        bestNode = id;
      }
    }
    roots.push(bestNode);
  }

  // BFS to assign layer depths.
  const queue: string[] = [...roots];
  for (const r of roots) layers.set(r, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = layers.get(current)!;

    graph.forEachOutNeighbor(current, (neighbor) => {
      if (!layers.has(neighbor)) {
        layers.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
    });
  }

  // Assign remaining unreachable nodes to layer 0.
  for (const id of nodeIds) {
    if (!layers.has(id)) {
      layers.set(id, 0);
    }
  }

  // Group nodes by layer.
  const layerGroups: Map<number, string[]> = new Map();
  for (const [id, depth] of layers) {
    const group = layerGroups.get(depth) ?? [];
    group.push(id);
    layerGroups.set(depth, group);
  }

  const maxLayer = Math.max(...layerGroups.keys());
  const LAYER_SPACING = 150;
  const NODE_SPACING = 80;

  for (const [depth, members] of layerGroups) {
    const y = depth * LAYER_SPACING;
    const totalWidth = (members.length - 1) * NODE_SPACING;
    const startX = -totalWidth / 2;

    for (let i = 0; i < members.length; i++) {
      positions.set(members[i], {
        x: startX + i * NODE_SPACING,
        y,
      });
    }
  }

  // Center the layout around the origin.
  if (maxLayer >= 0) {
    const centerY = (maxLayer * LAYER_SPACING) / 2;
    for (const [id, pos] of positions) {
      positions.set(id, { x: pos.x, y: pos.y - centerY });
    }
  }

  return positions;
}

/**
 * Compute a radial layout centered on the most-connected node.
 *
 * 1. Find the node with the highest degree (center).
 * 2. Place immediate neighbors on the first ring.
 * 3. Place 2-hop neighbors on the second ring, and so on via BFS.
 * 4. Spread nodes evenly around each ring.
 */
function computeRadialLayout(graph: MultiDirectedGraph): PositionMap {
  const positions: PositionMap = new Map();
  const nodeIds: string[] = [];
  graph.forEachNode((id) => nodeIds.push(id));

  if (nodeIds.length === 0) return positions;

  // Find the most-connected node.
  let centerNode = nodeIds[0];
  let maxDegree = 0;
  for (const id of nodeIds) {
    const deg = graph.degree(id);
    if (deg > maxDegree) {
      maxDegree = deg;
      centerNode = id;
    }
  }

  // BFS from center to assign ring levels.
  const ringMap: Map<string, number> = new Map();
  ringMap.set(centerNode, 0);
  const queue: string[] = [centerNode];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentRing = ringMap.get(current)!;

    graph.forEachNeighbor(current, (neighbor) => {
      if (!ringMap.has(neighbor)) {
        ringMap.set(neighbor, currentRing + 1);
        queue.push(neighbor);
      }
    });
  }

  // Assign any unreachable nodes to ring 1.
  for (const id of nodeIds) {
    if (!ringMap.has(id)) {
      ringMap.set(id, 1);
    }
  }

  // Group by ring.
  const ringGroups: Map<number, string[]> = new Map();
  for (const [id, ring] of ringMap) {
    const group = ringGroups.get(ring) ?? [];
    group.push(id);
    ringGroups.set(ring, group);
  }

  // Place center node at origin.
  positions.set(centerNode, { x: 0, y: 0 });

  const RADIUS_STEP = 200;

  for (const [ring, members] of ringGroups) {
    if (ring === 0) continue; // Already placed at origin.

    const radius = ring * RADIUS_STEP;
    const count = members.length;

    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      positions.set(members[i], {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }
  }

  return positions;
}

/**
 * Animate node positions from their current locations to new target positions
 * over a given duration using requestAnimationFrame with ease-out cubic.
 *
 * Returns the requestAnimationFrame ID so the caller can cancel if needed.
 */
function animatePositions(
  graph: MultiDirectedGraph,
  targets: PositionMap,
  duration: number,
  onComplete?: () => void,
): number {
  // Capture starting positions.
  const starts: PositionMap = new Map();
  graph.forEachNode((id, attrs) => {
    starts.set(id, { x: attrs.x as number, y: attrs.y as number });
  });

  const t0 = performance.now();
  let frameId = 0;

  function tick() {
    const elapsed = performance.now() - t0;
    const progress = Math.min(elapsed / duration, 1);
    // Ease-out cubic for smooth deceleration.
    const ease = 1 - Math.pow(1 - progress, 3);

    graph.forEachNode((id) => {
      const start = starts.get(id);
      const target = targets.get(id);
      if (!start || !target) return;

      graph.setNodeAttribute(id, 'x', start.x + (target.x - start.x) * ease);
      graph.setNodeAttribute(id, 'y', start.y + (target.y - start.y) * ease);
    });

    if (progress < 1) {
      frameId = requestAnimationFrame(tick);
    } else {
      onComplete?.();
    }
  }

  frameId = requestAnimationFrame(tick);
  return frameId;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Core graph visualisation component.
 *
 * Renders the knowledge graph using Sigma.js with WebGL acceleration.
 * Supports three layout modes: force (ForceAtlas2 in web worker),
 * tree (hierarchical top-to-bottom), and radial (concentric rings).
 * Node/edge visibility, selection, and hover dimming are all handled
 * through nodeReducer/edgeReducer callbacks.
 */
export function GraphCanvas({ className }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const layoutRef = useRef<FA2LayoutSupervisor | null>(null);
  const animFrameRef = useRef<number>(0);
  const { graphRef, loading, error } = useGraph();
  const [layoutRunning, setLayoutRunning] = useState(false);
  // Local state to trigger re-render when sigma instance becomes available.
  const [sigmaReady, setSigmaReady] = useState(false);

  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId);
  const visibleNodeTypes = useGraphStore((s) => s.visibleNodeTypes);
  const visibleEdgeTypes = useGraphStore((s) => s.visibleEdgeTypes);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setHoveredNode = useGraphStore((s) => s.setHoveredNode);
  const layoutMode = useGraphStore((s) => s.layoutMode);
  const minimapVisible = useGraphStore((s) => s.minimapVisible);

  /** Zoom the camera in by one step. */
  const zoomIn = useCallback(() => {
    const camera = sigmaRef.current?.getCamera();
    if (camera) {
      camera.animatedZoom({ duration: 200 });
    }
  }, []);

  /** Zoom the camera out by one step. */
  const zoomOut = useCallback(() => {
    const camera = sigmaRef.current?.getCamera();
    if (camera) {
      camera.animatedUnzoom({ duration: 200 });
    }
  }, []);

  /** Reset the camera to show the entire graph. */
  const fitToScreen = useCallback(() => {
    const camera = sigmaRef.current?.getCamera();
    if (camera) {
      camera.animatedReset({ duration: 300 });
    }
  }, []);

  /** Toggle the ForceAtlas2 layout on/off (only relevant in force mode). */
  const toggleLayout = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout) return;

    if (layout.isRunning()) {
      layout.stop();
      setLayoutRunning(false);
    } else {
      layout.start();
      setLayoutRunning(true);
    }
  }, []);

  // Initialise Sigma and ForceAtlas2 when the Graphology graph is ready.
  useEffect(() => {
    const container = containerRef.current;
    const graph = graphRef.current;
    if (!container || !graph) return;

    // Snapshot the current store values for the reducers. The refresh effect
    // below triggers sigma.refresh() whenever these change, which causes
    // Sigma to re-invoke the reducers with fresh closure values.
    // Create a bordered node program: inner fill + thin outer border ring.
    const BorderedNodeProgram = createNodeBorderProgram({
      borders: [
        { size: { value: 0.15, mode: 'relative' }, color: { attribute: 'borderColor', defaultValue: '#5a6a7a' } },
        { size: { fill: true }, color: { attribute: 'color' } },
      ],
    });

    const sigma = new Sigma(graph, container, {
      renderLabels: true,
      labelFont: 'JetBrains Mono, monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#8899aa' },
      defaultEdgeColor: '#1e2a36',
      defaultNodeColor: '#4a5a6a',
      // Only show labels for nodes that are large enough (high degree).
      labelRenderedSizeThreshold: 12,
      // Reduce label density to prevent overlap.
      labelDensity: 0.5,
      labelGridCellSize: 120,
      // Hide edges while panning/zooming to reduce clutter.
      hideEdgesOnMove: true,
      // Use bordered node program instead of plain circle.
      defaultNodeType: 'bordered',
      nodeProgramClasses: {
        bordered: BorderedNodeProgram,
      },

      nodeReducer: (node, data) => {
        const res = { ...data };
        const nodeType = (data.nodeType ?? '') as string;

        const state = useGraphStore.getState();

        if (!state.visibleNodeTypes.has(nodeType)) {
          res.hidden = true;
          return res;
        }

        // Dim unrelated nodes when a node is selected.
        if (state.selectedNodeId && node !== state.selectedNodeId) {
          const isNeighbor =
            graph.hasEdge(state.selectedNodeId, node) ||
            graph.hasEdge(node, state.selectedNodeId);
          if (!isNeighbor) {
            res.color = '#141a22';
            res.label = '';
            res.zIndex = 0;
          } else {
            // Connected neighbors stay visible and get a label.
            res.forceLabel = true;
            res.zIndex = 2;
          }
        }

        // Selected node itself: brighten and force label.
        if (state.selectedNodeId && node === state.selectedNodeId) {
          res.highlighted = true;
          res.forceLabel = true;
          res.zIndex = 3;
        }

        // Highlight on hover.
        if (state.hoveredNodeId && node === state.hoveredNodeId) {
          res.highlighted = true;
          res.forceLabel = true;
        }

        return res;
      },

      edgeReducer: (edge, data) => {
        const res = { ...data };
        const edgeType = (data.edgeType ?? '') as string;

        const state = useGraphStore.getState();

        if (!state.visibleEdgeTypes.has(edgeType)) {
          res.hidden = true;
          return res;
        }

        if (state.selectedNodeId) {
          const source = graph.source(edge);
          const target = graph.target(edge);
          if (source !== state.selectedNodeId && target !== state.selectedNodeId) {
            // Dim unconnected edges almost invisible.
            res.hidden = true;
          } else {
            // Brighten connected edges.
            res.color = '#4488cc';
            res.size = 1.5;
          }
        }

        return res;
      },
    });

    sigmaRef.current = sigma;
    setSigmaReady(true);

    // Wire up interaction events.
    sigma.on('clickNode', ({ node }) => {
      selectNode(node);
    });

    sigma.on('clickStage', () => {
      selectNode(null);
    });

    sigma.on('enterNode', ({ node }) => {
      setHoveredNode(node);
    });

    sigma.on('leaveNode', () => {
      setHoveredNode(null);
    });

    // Start ForceAtlas2 layout in a web worker.
    // Tuned for ~2k–5k node graphs on a dark canvas:
    //   - Higher scalingRatio (8) pushes nodes further apart
    //   - Lower gravity (0.3) prevents tight clustering
    //   - strongGravityMode keeps outliers from drifting to infinity
    //   - barnesHutOptimize for O(n log n) performance
    const layout = new FA2LayoutSupervisor(graph, {
      settings: {
        gravity: 0.3,
        scalingRatio: 8,
        strongGravityMode: true,
        barnesHutOptimize: true,
        barnesHutTheta: 0.5,
        slowDown: 3,
      },
    });
    layout.start();
    layoutRef.current = layout;
    setLayoutRunning(true);

    // Stop the layout after 30 seconds to save CPU.
    const timer = setTimeout(() => {
      if (layout.isRunning()) {
        layout.stop();
        setLayoutRunning(false);
      }
    }, 30_000);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(animFrameRef.current);
      layout.kill();
      sigma.kill();
      sigmaRef.current = null;
      layoutRef.current = null;
      setSigmaReady(false);
      setLayoutRunning(false);
    };
  }, [loading, selectNode, setHoveredNode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply layout mode changes.
  useEffect(() => {
    const graph = graphRef.current;
    const layout = layoutRef.current;
    if (!graph || !sigmaRef.current) return;

    // Cancel any running position animation.
    cancelAnimationFrame(animFrameRef.current);

    if (layoutMode === 'force') {
      // Re-enable ForceAtlas2. Start the web worker layout.
      if (layout && !layout.isRunning()) {
        layout.start();
        setLayoutRunning(true);

        // Auto-stop after 30s again.
        const timer = setTimeout(() => {
          if (layout.isRunning()) {
            layout.stop();
            setLayoutRunning(false);
          }
        }, 30_000);

        return () => clearTimeout(timer);
      }
    } else {
      // Stop force layout when switching to tree or radial.
      if (layout && layout.isRunning()) {
        layout.stop();
        setLayoutRunning(false);
      }

      const targets =
        layoutMode === 'tree'
          ? computeTreeLayout(graph)
          : computeRadialLayout(graph);

      animFrameRef.current = animatePositions(graph, targets, 500);
    }
  }, [layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render Sigma when filters, selection, or hover state change.
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [selectedNodeId, hoveredNodeId, visibleNodeTypes, visibleEdgeTypes]);

  // Determine if the graph is empty (loaded but no nodes).
  const nodes = useGraphStore((s) => s.nodes);
  const graphEmpty = !loading && !error && nodes.length === 0;

  if (error) {
    return (
      <div
        className={cn('flex items-center justify-center h-full', className)}
        style={{
          color: 'var(--danger)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
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
    <div className={cn('relative w-full h-full', className)} style={{ background: 'var(--bg-primary)' }}>
      <div ref={containerRef} className="w-full h-full" />
      <GraphControls
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFitToScreen={fitToScreen}
        onToggleLayout={toggleLayout}
        layoutRunning={layoutRunning}
      />
      {layoutRunning && <LayoutIndicator />}
      {minimapVisible && sigmaReady && sigmaRef.current && (
        <Minimap sigma={sigmaRef.current} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline GraphControls (small enough to co-locate)
// ---------------------------------------------------------------------------

interface GraphControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  onToggleLayout: () => void;
  layoutRunning: boolean;
}

/**
 * Floating control bar at the bottom-left of the graph canvas.
 *
 * Four small buttons stacked vertically: zoom in, zoom out, fit to screen,
 * and play/pause the force-directed layout.
 */
function GraphControls({
  onZoomIn,
  onZoomOut,
  onFitToScreen,
  onToggleLayout,
  layoutRunning,
}: GraphControlsProps) {
  return (
    <div
      className="absolute bottom-3 left-3 flex flex-col gap-1"
      style={{ zIndex: 10 }}
    >
      <ControlButton onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
        <PlusIcon />
      </ControlButton>
      <ControlButton onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
        <MinusIcon />
      </ControlButton>
      <ControlButton onClick={onFitToScreen} title="Fit to screen" aria-label="Fit to screen">
        <MaximizeIcon />
      </ControlButton>
      <ControlButton onClick={onToggleLayout} title={layoutRunning ? 'Pause layout' : 'Resume layout'} aria-label={layoutRunning ? 'Pause layout' : 'Resume layout'}>
        {layoutRunning ? <PauseIcon /> : <PlayIcon />}
      </ControlButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Control button wrapper
// ---------------------------------------------------------------------------

interface ControlButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function ControlButton({ children, ...props }: ControlButtonProps) {
  return (
    <button
      type="button"
      className="flex items-center justify-center transition-colors"
      style={{
        width: 24,
        height: 24,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 2,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)';
      }}
      {...props}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons (12x12) to avoid importing lucide-react for 4 tiny icons
// ---------------------------------------------------------------------------

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="2" y1="6" x2="10" y2="6" />
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

// ---------------------------------------------------------------------------
// Layout-running indicator (bottom-left, above controls)
// ---------------------------------------------------------------------------

/**
 * Small indicator shown while ForceAtlas2 is optimising the layout.
 */
function LayoutIndicator() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 120,
        left: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 2,
        padding: '3px 8px',
        zIndex: 10,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--accent)',
          animation: 'axon-pulse 1.4s ease-in-out infinite',
        }}
      />
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: 'var(--text-secondary)',
        }}
      >
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
