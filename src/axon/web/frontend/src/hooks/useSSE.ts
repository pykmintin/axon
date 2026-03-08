import { useEffect, useRef } from 'react';
import { analysisApi, graphApi } from '@/api/client';
import { errorMessage } from '@/lib/utils';
import { useGraphStore } from '@/stores/graphStore';
import { useDataStore } from '@/stores/dataStore';

export function useSSE(): void {
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const setGraphData = useGraphStore((s) => s.setGraphData);
  const setOverview = useGraphStore((s) => s.setOverview);
  const setCommunities = useGraphStore((s) => s.setCommunities);
  const setDeadCode = useDataStore((s) => s.setDeadCode);
  const setHealthScore = useDataStore((s) => s.setHealthScore);

  useEffect(() => {
    function connect(): void {
      const source = new EventSource('/api/events');
      sourceRef.current = source;

      source.addEventListener('reindex_complete', () => {
        Promise.all([
          graphApi.getGraph(),
          graphApi.getOverview().catch(() => null),
          analysisApi.getCommunities().catch(() => null),
          analysisApi.getDeadCode().catch(() => null),
          analysisApi.getHealth().catch(() => null),
        ])
          .then(([graphData, overview, commResp, deadResp, healthResp]) => {
            if (!activeRef.current) return;
            setGraphData(graphData.nodes, graphData.edges);
            if (overview) setOverview(overview);
            if (commResp) setCommunities(commResp.communities);
            if (deadResp) setDeadCode(deadResp);
            if (healthResp) setHealthScore(healthResp);
          })
          .catch((err: unknown) => {
            console.error(errorMessage(err, 'Failed to fetch updated data'));
          });
      });

      source.addEventListener('reindex_start', () => {
        console.info('[SSE] Reindex started');
      });

      source.onerror = () => {
        source.close();
        sourceRef.current = null;

        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, 5_000);
      };
    }

    connect();

    return () => {
      activeRef.current = false;
      sourceRef.current?.close();
      sourceRef.current = null;

      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [setGraphData, setOverview, setCommunities, setDeadCode, setHealthScore]);
}
