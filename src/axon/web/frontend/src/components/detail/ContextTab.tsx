import { useEffect, useState, useCallback } from 'react';
import { graphApi } from '@/api/client';
import { useDataStore } from '@/stores/dataStore';
import { useGraphStore } from '@/stores/graphStore';
import { useViewStore } from '@/stores/viewStore';
import type { GraphNode, CallerCalleeEntry } from '@/types';
import { Zap, Eye } from 'lucide-react';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { TypeBadge } from '@/components/shared/TypeBadge';
import { shortPath } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Confidence tag
// ---------------------------------------------------------------------------

function ConfidenceTag({ confidence }: { confidence: number }) {
  if (confidence >= 0.9) return null;
  const symbol = confidence >= 0.5 ? '~' : '?';
  const color = confidence >= 0.5 ? 'var(--warning)' : 'var(--danger)';
  return (
    <span
      style={{
        color,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        marginLeft: 4,
      }}
    >
      {symbol}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Collapsible edge list (callers / callees)
// ---------------------------------------------------------------------------

function EdgeList({
  title,
  entries,
  onNavigate,
}: {
  title: string;
  entries: CallerCalleeEntry[];
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewCount = 3;
  const visible = expanded ? entries : entries.slice(0, previewCount);
  const remaining = entries.length - previewCount;

  if (entries.length === 0) return null;

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: 8,
      }}
    >
      <div className="section-heading" style={{ marginBottom: 4, fontSize: 11 }}>
        {title} ({entries.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visible.map((entry, i) => {
          const isLast = i === visible.length - 1 && (expanded || entries.length <= previewCount);
          const prefix = isLast ? '\u2514' : '\u251C';
          return (
            <button
              key={entry.node.id}
              onClick={() => onNavigate(entry.node.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '1px 0',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: 'var(--text-primary)',
                textAlign: 'left',
                width: '100%',
              }}
            >
              <span style={{ color: 'var(--text-dimmed)' }}>{prefix}</span>
              <TypeBadge label={entry.node.label} />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.node.name}
              </span>
              <span
                style={{
                  color: 'var(--text-dimmed)',
                  fontSize: 10,
                  flexShrink: 0,
                }}
              >
                {shortPath(entry.node.filePath)}
              </span>
              <ConfidenceTag confidence={entry.confidence} />
            </button>
          );
        })}
        {!expanded && remaining > 0 && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--accent)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              textAlign: 'left',
              padding: '1px 0 1px 16px',
            }}
          >
            + {remaining} more
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type refs list
// ---------------------------------------------------------------------------

function TypeRefsList({
  typeRefs,
  onNavigate,
}: {
  typeRefs: GraphNode[];
  onNavigate: (id: string) => void;
}) {
  if (typeRefs.length === 0) return null;

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: 8,
      }}
    >
      <div className="section-heading" style={{ marginBottom: 4, fontSize: 11 }}>
        TYPE REFS ({typeRefs.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {typeRefs.map((node) => (
          <button
            key={node.id}
            onClick={() => onNavigate(node.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '1px 0',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--text-primary)',
              textAlign: 'left',
              width: '100%',
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
              {shortPath(node.filePath)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ContextTabProps {
  nodeId: string;
}

export function ContextTab({ nodeId }: ContextTabProps) {
  const setNodeContext = useDataStore((s) => s.setNodeContext);
  const nodeContext = useDataStore((s) => s.nodeContext);
  const loading = useDataStore((s) => s.loading);
  const setLoading = useDataStore((s) => s.setLoading);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setRightTab = useViewStore((s) => s.setRightTab);

  const [error, setError] = useState<string | null>(null);

  const fetchContext = useCallback(
    async (id: string) => {
      setLoading('nodeContext', true);
      setError(null);
      try {
        const ctx = await graphApi.getNode(id);
        setNodeContext(ctx);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load node context');
        setNodeContext(null);
      } finally {
        setLoading('nodeContext', false);
      }
    },
    [setLoading, setNodeContext],
  );

  useEffect(() => {
    void fetchContext(nodeId);
  }, [nodeId, fetchContext]);

  const handleNavigate = useCallback(
    (id: string) => {
      selectNode(id);
    },
    [selectNode],
  );

  if (loading['nodeContext']) {
    return (
      <div className="p-4">
        <LoadingSpinner message="Loading context..." />
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

  if (!nodeContext) return null;

  const { node, callers, callees, typeRefs, processMemberships } = nodeContext;

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <TypeBadge label={node.label} />
          <span
            style={{
              color: 'var(--text-bright)',
              fontWeight: 600,
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.name}
          </span>
        </div>

        <div style={{ color: 'var(--text-secondary)', fontSize: 10, marginBottom: 4 }}>
          {capitalize(node.label)}
          {node.className ? ` \u00B7 ${node.className}` : ''}
          {' \u00B7 '}
          {shortPath(node.filePath)}:{node.startLine}-{node.endLine}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {node.isDead && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--danger)',
                border: '1px solid var(--danger)',
                borderRadius: 'var(--radius)',
                padding: '0 4px',
              }}
            >
              DEAD CODE
            </span>
          )}
          {node.isEntryPoint && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius)',
                padding: '0 4px',
              }}
            >
              {'\u25CF'} ENTRY POINT
            </span>
          )}
          {node.isExported && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--info)',
                border: '1px solid var(--info)',
                borderRadius: 'var(--radius)',
                padding: '0 4px',
              }}
            >
              EXPORTED
            </span>
          )}
        </div>

        {processMemberships.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
            Community: {processMemberships.join(', ')}
          </div>
        )}
      </div>

      {node.signature && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 8 }}>
          <div className="section-heading" style={{ marginBottom: 4, fontSize: 11 }}>
            SIGNATURE
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              background: 'var(--bg-primary)',
              padding: 4,
              borderRadius: 'var(--radius)',
            }}
          >
            {node.signature}
          </div>
        </div>
      )}

      <EdgeList title="CALLERS" entries={callers} onNavigate={handleNavigate} />

      <EdgeList title="CALLEES" entries={callees} onNavigate={handleNavigate} />

      <TypeRefsList typeRefs={typeRefs} onNavigate={handleNavigate} />

      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: 8,
          display: 'flex',
          gap: 6,
        }}
      >
        <button
          onClick={() => setRightTab('impact')}
          style={{
            flex: 1,
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
          <Zap size={11} />
          Analyze Impact
        </button>
        <button
          onClick={() => setRightTab('code')}
          style={{
            flex: 1,
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
          <Eye size={11} />
          Show Code
        </button>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
