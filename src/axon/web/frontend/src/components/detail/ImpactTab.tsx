import { useEffect, useState, useCallback } from 'react';
import { analysisApi } from '@/api/client';
import { useDataStore } from '@/stores/dataStore';
import { useGraphStore } from '@/stores/graphStore';
import type { ImpactResult, GraphNode } from '@/types';
import { ChevronDown, ChevronRight, Radar } from 'lucide-react';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { TypeBadge } from '@/components/shared/TypeBadge';
import { shortPath } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Depth section styling
// ---------------------------------------------------------------------------

interface DepthConfig {
  label: string;
  borderColor: string;
}

function getDepthConfig(depth: number): DepthConfig {
  if (depth === 1) return { label: 'Direct callers (will break)', borderColor: 'var(--danger)' };
  if (depth === 2) return { label: 'Indirect (may break)', borderColor: 'var(--orange)' };
  return { label: 'Transitive (review)', borderColor: 'var(--yellow)' };
}

// ---------------------------------------------------------------------------
// Collapsible depth section
// ---------------------------------------------------------------------------

function DepthSection({
  depth,
  nodes,
  onNavigate,
}: {
  depth: number;
  nodes: GraphNode[];
  onNavigate: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const config = getDepthConfig(depth);
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      style={{
        borderLeft: `2px solid ${config.borderColor}`,
        marginBottom: 4,
      }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 8px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--text-bright)',
          textAlign: 'left',
        }}
      >
        <Chevron size={12} style={{ color: 'var(--text-dimmed)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600 }}>Depth {depth}</span>
        <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
          {'\u2014'} {config.label}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            color: config.borderColor,
            fontSize: 10,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {nodes.length}
        </span>
      </button>

      {!collapsed && (
        <div style={{ padding: '0 8px 4px 20px' }}>
          {nodes.map((node) => (
            <button
              key={node.id}
              onClick={() => onNavigate(node.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '1px 0',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
            >
              <TypeBadge label={node.label} />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {node.name}
              </span>
              <span
                style={{
                  color: 'var(--text-dimmed)',
                  fontSize: 10,
                  flexShrink: 0,
                }}
              >
                {shortPath(node.filePath)}:{node.startLine}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ImpactTabProps {
  nodeId: string;
}

export function ImpactTab({ nodeId }: ImpactTabProps) {
  const impactResult = useDataStore((s) => s.impactResult);
  const setImpactResult = useDataStore((s) => s.setImpactResult);
  const loading = useDataStore((s) => s.loading);
  const setLoading = useDataStore((s) => s.setLoading);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setBlastRadius = useGraphStore((s) => s.setBlastRadius);
  const setHighlightedNodes = useGraphStore((s) => s.setHighlightedNodes);

  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(3);

  const fetchImpact = useCallback(
    async (id: string, d: number) => {
      setLoading('impact', true);
      setError(null);
      try {
        const result = await analysisApi.getImpact(id, d);
        setImpactResult(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load impact analysis');
        setImpactResult(null);
      } finally {
        setLoading('impact', false);
      }
    },
    [setLoading, setImpactResult],
  );

  useEffect(() => {
    void fetchImpact(nodeId, depth);
  }, [nodeId, depth, fetchImpact]);

  const handleNavigate = useCallback(
    (id: string) => {
      selectNode(id);
    },
    [selectNode],
  );

  const handleVisualize = useCallback(() => {
    if (!impactResult) return;
    const map = new Map<string, number>();
    for (const [depthKey, nodes] of Object.entries(impactResult.depths)) {
      const d = parseInt(depthKey, 10);
      for (const node of nodes) {
        map.set(node.id, d);
      }
    }
    setBlastRadius(map);
    // Also highlight all affected nodes
    setHighlightedNodes(new Set(map.keys()));
  }, [impactResult, setBlastRadius, setHighlightedNodes]);

  if (loading['impact']) {
    return (
      <div className="p-4">
        <LoadingSpinner message="Analyzing impact..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-2" style={{ color: 'var(--danger)', fontSize: 11 }}>
        {error}
      </div>
    );
  }

  if (!impactResult) return null;

  // Sort depth keys numerically
  const depthKeys = Object.keys(impactResult.depths)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
          }}
        >
          <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontSize: 12 }}>
            Impact Analysis: {impactResult.target.name}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--bg-primary)',
              background: 'var(--accent)',
              borderRadius: 'var(--radius)',
              padding: '0 4px',
            }}
          >
            {impactResult.affected}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>Depth:</span>
          {[1, 2, 3, 4, 5].map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              style={{
                width: 20,
                height: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: d === depth ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                border: `1px solid ${d === depth ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                color: d === depth ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                fontWeight: 600,
                padding: 0,
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '4px 8px' }}>
        {depthKeys.map((d) => {
          const nodes = impactResult.depths[String(d)];
          if (!nodes || nodes.length === 0) return null;
          return (
            <DepthSection
              key={d}
              depth={d}
              nodes={nodes}
              onNavigate={handleNavigate}
            />
          );
        })}
      </div>

      <div style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
        <button
          onClick={handleVisualize}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: '4px 8px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
          }}
        >
          <Radar size={11} />
          Visualize on Graph
        </button>
      </div>
    </div>
  );
}
