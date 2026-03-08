import { useCallback, useState } from 'react';
import { diffApi } from '@/api/client';
import { useGraphStore } from '@/stores/graphStore';
import { useViewStore } from '@/stores/viewStore';
import type { DiffResult, GraphNode, ModifiedNodePair } from '@/types';
import { TypeBadge } from '@/components/shared/TypeBadge';
import { errorMessage, shortPath } from '@/lib/utils';

function NodeRow({
  node,
  changeColor,
  onClick,
}: {
  node: GraphNode;
  changeColor: string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 4px',
        cursor: 'pointer',
        fontSize: 11,
        color: changeColor,
        fontFamily: "'JetBrains Mono', monospace",
        borderLeft: `2px solid ${changeColor}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <TypeBadge label={node.label} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {node.name}
      </span>
      <span style={{ fontSize: 9, color: 'var(--text-dimmed)', flexShrink: 0 }}>
        {shortPath(node.filePath)}:{node.startLine}
      </span>
    </div>
  );
}

export function BranchDiff() {
  const [base, setBase] = useState('main');
  const [compare, setCompare] = useState('HEAD');
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectNode = useGraphStore((s) => s.selectNode);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const handleCompare = useCallback(async () => {
    if (!base.trim() || !compare.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await diffApi.compare(base.trim(), compare.trim());
      setResult(data);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to compare branches'));
    } finally {
      setLoading(false);
    }
  }, [base, compare]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      setActiveView('explorer');
      selectNode(nodeId);
    },
    [setActiveView, selectNode],
  );

  const handleOpenInExplorer = useCallback(() => {
    if (!result) return;
    setActiveView('explorer');
    const added = new Set(result.added.map((n) => n.id));
    const removed = new Set(result.removed.map((n) => n.id));
    const modified = new Set(result.modified.map((m) => m.after.id));
    useGraphStore.getState().setDiffOverlay({ added, removed, modified });
  }, [result, setActiveView]);

  const addedCount = result?.added.length ?? 0;
  const removedCount = result?.removed.length ?? 0;
  const modifiedCount = result?.modified.length ?? 0;

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="text"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="Base branch"
          style={{
            flex: 1,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            padding: '4px 6px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            outline: 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-focus)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
        />
        <span style={{ fontSize: 10, color: 'var(--text-dimmed)' }}>{'\u2192'}</span>
        <input
          type="text"
          value={compare}
          onChange={(e) => setCompare(e.target.value)}
          placeholder="Compare branch"
          style={{
            flex: 1,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            padding: '4px 6px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            outline: 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-focus)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
        />
        <button
          onClick={handleCompare}
          disabled={loading}
          style={{
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            border: '1px solid var(--accent-muted)',
            borderRadius: 'var(--radius)',
            padding: '4px 10px',
            fontSize: 10,
            fontWeight: 600,
            fontFamily: "'JetBrains Mono', monospace",
            cursor: loading ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {loading ? '...' : 'Compare'}
        </button>
      </div>

      {error && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--danger)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              display: 'flex',
              gap: 12,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            <span style={{ color: 'var(--accent)' }}>+{addedCount} added</span>
            <span style={{ color: 'var(--danger)' }}>&minus;{removedCount} removed</span>
            <span style={{ color: 'var(--warning)' }}>~{modifiedCount} modified</span>
          </div>

          <button
            onClick={handleOpenInExplorer}
            style={{
              alignSelf: 'flex-start',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '2px 8px',
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: 'pointer',
            }}
          >
            Open in Explorer
          </button>

          {addedCount > 0 && (
            <Section title="Added" color="var(--accent)">
              {result.added.map((node) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  changeColor="var(--accent)"
                  onClick={() => handleNodeClick(node.id)}
                />
              ))}
            </Section>
          )}

          {removedCount > 0 && (
            <Section title="Removed" color="var(--danger)">
              {result.removed.map((node) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  changeColor="var(--danger)"
                  onClick={() => handleNodeClick(node.id)}
                />
              ))}
            </Section>
          )}

          {modifiedCount > 0 && (
            <Section title="Modified" color="var(--warning)">
              {result.modified.map((pair: ModifiedNodePair) => (
                <NodeRow
                  key={pair.after.id}
                  node={pair.after}
                  changeColor="var(--warning)"
                  onClick={() => handleNodeClick(pair.after.id)}
                />
              ))}
            </Section>
          )}

          {addedCount === 0 && removedCount === 0 && modifiedCount === 0 && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-dimmed)',
                fontFamily: "'JetBrains Mono', monospace",
                textAlign: 'center',
                padding: 8,
              }}
            >
              No structural differences found
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          fontFamily: "'IBM Plex Mono', monospace",
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color,
          paddingBottom: 2,
          borderBottom: `1px solid var(--border)`,
          marginBottom: 2,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
