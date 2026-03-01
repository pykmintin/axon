import { create } from 'zustand';
import type { GraphNode, GraphEdge, Community, OverviewStats, DiffOverlay } from '@/types';

interface GraphStore {
  // Data
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Community[];
  overview: OverviewStats | null;

  // Selection
  selectedNodeId: string | null;
  hoveredNodeId: string | null;

  // Visual overlays
  highlightedNodeIds: Set<string>;
  blastRadiusNodes: Map<string, number>;
  flowTraceNodeIds: string[];
  diffOverlay: DiffOverlay | null;

  // Filters
  visibleNodeTypes: Set<string>;
  visibleEdgeTypes: Set<string>;
  depthLimit: number | null;
  layoutMode: 'force' | 'tree' | 'radial';

  // Display toggles
  hullsVisible: boolean;
  minimapVisible: boolean;

  // Actions
  setGraphData: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  setCommunities: (communities: Community[]) => void;
  setOverview: (overview: OverviewStats) => void;
  selectNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setHighlightedNodes: (ids: Set<string>) => void;
  setBlastRadius: (nodes: Map<string, number>) => void;
  clearBlastRadius: () => void;
  setFlowTrace: (nodeIds: string[]) => void;
  clearFlowTrace: () => void;
  setDiffOverlay: (overlay: DiffOverlay | null) => void;
  toggleNodeType: (type: string) => void;
  toggleEdgeType: (type: string) => void;
  setDepthLimit: (depth: number | null) => void;
  setLayoutMode: (mode: 'force' | 'tree' | 'radial') => void;
  toggleHulls: () => void;
  toggleMinimap: () => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  // Data
  nodes: [],
  edges: [],
  communities: [],
  overview: null,

  // Selection
  selectedNodeId: null,
  hoveredNodeId: null,

  // Visual overlays
  highlightedNodeIds: new Set(),
  blastRadiusNodes: new Map(),
  flowTraceNodeIds: [],
  diffOverlay: null,

  // Filters — default: show code symbols + calls/imports
  visibleNodeTypes: new Set(['function', 'class', 'method', 'interface']),
  visibleEdgeTypes: new Set(['calls', 'imports']),
  depthLimit: null,
  layoutMode: 'force',

  // Display toggles
  hullsVisible: false,
  minimapVisible: false,

  // Actions
  setGraphData: (nodes, edges) => set({ nodes, edges }),
  setCommunities: (communities) => set({ communities }),
  setOverview: (overview) => set({ overview }),
  selectNode: (id) => set({ selectedNodeId: id }),
  setHoveredNode: (id) => set({ hoveredNodeId: id }),
  setHighlightedNodes: (ids) => set({ highlightedNodeIds: ids }),
  setBlastRadius: (nodes) => set({ blastRadiusNodes: nodes }),
  clearBlastRadius: () => set({ blastRadiusNodes: new Map(), highlightedNodeIds: new Set() }),
  setFlowTrace: (nodeIds) => set({ flowTraceNodeIds: nodeIds }),
  clearFlowTrace: () => set({ flowTraceNodeIds: [], highlightedNodeIds: new Set() }),
  setDiffOverlay: (overlay) => set({ diffOverlay: overlay }),
  toggleNodeType: (type) => set((s) => {
    const next = new Set(s.visibleNodeTypes);
    next.has(type) ? next.delete(type) : next.add(type);
    return { visibleNodeTypes: next };
  }),
  toggleEdgeType: (type) => set((s) => {
    const next = new Set(s.visibleEdgeTypes);
    next.has(type) ? next.delete(type) : next.add(type);
    return { visibleEdgeTypes: next };
  }),
  setDepthLimit: (depth) => set({ depthLimit: depth }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  toggleHulls: () => set((s) => ({ hullsVisible: !s.hullsVisible })),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
}));
