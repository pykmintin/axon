/**
 * Custom hook that loads the full knowledge graph from the API, builds a
 * Graphology instance, and populates the global graph store.
 *
 * The Graphology ref is returned so that the GraphCanvas component can
 * pass it to Sigma without re-creating it on every render.
 */

import { useEffect, useRef, useState } from 'react';
import type { MultiDirectedGraph } from 'graphology';
import { graphApi } from '@/api/client';
import { buildGraphology } from '@/lib/graphAdapter';
import { useGraphStore } from '@/stores/graphStore';

export interface UseGraphReturn {
  graphRef: React.RefObject<MultiDirectedGraph | null>;
  loading: boolean;
  error: string | null;
}

/**
 * Fetch the graph and overview data, build a Graphology instance, and sync
 * the result into the Zustand store.
 *
 * The returned `graphRef` is stable across re-renders; only its `.current`
 * value changes once the fetch completes.
 */
export function useGraph(): UseGraphReturn {
  const graphRef = useRef<MultiDirectedGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setGraphData = useGraphStore((s) => s.setGraphData);
  const setOverview = useGraphStore((s) => s.setOverview);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const [graphData, overview] = await Promise.all([
          graphApi.getGraph(),
          graphApi.getOverview(),
        ]);

        if (cancelled) return;

        const graph = buildGraphology(graphData.nodes, graphData.edges);
        graphRef.current = graph;

        setGraphData(graphData.nodes, graphData.edges);

        setOverview(overview);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load graph');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [setGraphData, setOverview]);

  return { graphRef, loading, error };
}
