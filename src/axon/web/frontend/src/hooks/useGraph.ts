import { useEffect, useRef, useState } from 'react';
import type { MultiDirectedGraph } from 'graphology';
import { analysisApi, graphApi } from '@/api/client';
import { buildGraphology } from '@/lib/graphAdapter';
import { errorMessage } from '@/lib/utils';
import { useDataStore } from '@/stores/dataStore';
import { useGraphStore } from '@/stores/graphStore';

export interface UseGraphReturn {
  graphRef: React.RefObject<MultiDirectedGraph | null>;
  loading: boolean;
  error: string | null;
}

export function useGraph(): UseGraphReturn {
  const graphRef = useRef<MultiDirectedGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setGraphData = useGraphStore((s) => s.setGraphData);
  const setOverview = useGraphStore((s) => s.setOverview);
  const setCommunities = useGraphStore((s) => s.setCommunities);
  const setDeadCode = useDataStore((s) => s.setDeadCode);
  const setHealthScore = useDataStore((s) => s.setHealthScore);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const [graphData, overview, commResp, deadResp, healthResp] = await Promise.all([
          graphApi.getGraph(),
          graphApi.getOverview(),
          analysisApi.getCommunities().catch(() => null),
          analysisApi.getDeadCode().catch(() => null),
          analysisApi.getHealth().catch(() => null),
        ]);

        if (cancelled) return;

        const graph = buildGraphology(graphData.nodes, graphData.edges);
        graphRef.current = graph;

        setGraphData(graphData.nodes, graphData.edges);
        setOverview(overview);
        if (commResp) setCommunities(commResp.communities);
        if (deadResp) setDeadCode(deadResp);
        if (healthResp) setHealthScore(healthResp);
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e, 'Failed to load graph'));
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
  }, [setGraphData, setOverview, setCommunities, setDeadCode, setHealthScore]);

  return { graphRef, loading, error };
}
