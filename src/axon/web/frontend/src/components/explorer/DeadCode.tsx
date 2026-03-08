import { useCallback, useEffect, useState } from 'react';
import { analysisApi } from '@/api/client';
import { errorMessage } from '@/lib/utils';
import { useGraphStore } from '@/stores/graphStore';
import type { DeadCodeReport, DeadCodeEntry } from '@/types';
import { TypeBadge } from '@/components/shared/TypeBadge';

export function DeadCode() {
  const [report, setReport] = useState<DeadCodeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlighting, setHighlighting] = useState(false);

  const nodes = useGraphStore((s) => s.nodes);
  const setHighlightedNodes = useGraphStore((s) => s.setHighlightedNodes);
  const selectNode = useGraphStore((s) => s.selectNode);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    analysisApi
      .getDeadCode()
      .then((data) => {
        if (!cancelled) {
          setReport(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load dead code'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShowAll = useCallback(() => {
    if (!report) return;
    const deadIds = new Set<string>();
    for (const [filePath, entries] of Object.entries(report.byFile)) {
      for (const entry of entries) {
        const match = nodes.find(
          (n) =>
            n.name === entry.name &&
            n.filePath === filePath &&
            n.startLine === entry.line,
        );
        if (match) deadIds.add(match.id);
      }
    }
    for (const node of nodes) {
      if (node.isDead) deadIds.add(node.id);
    }
    setHighlightedNodes(deadIds);
    setHighlighting(true);
  }, [report, nodes, setHighlightedNodes]);

  const handleClear = useCallback(() => {
    setHighlightedNodes(new Set());
    setHighlighting(false);
  }, [setHighlightedNodes]);

  const handleSymbolClick = useCallback(
    (filePath: string, entry: DeadCodeEntry) => {
      const match = nodes.find(
        (n) =>
          n.name === entry.name &&
          n.filePath === filePath &&
          n.startLine === entry.line,
      );
      if (match) {
        selectNode(match.id);
      }
    },
    [nodes, selectNode],
  );

  if (loading) {
    return (
      <div className="p-2" style={{ color: 'var(--text-secondary)' }}>
        Loading dead code...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-2" style={{ color: 'var(--danger)' }}>
        Error: {error}
      </div>
    );
  }

  if (!report || report.total === 0) {
    return (
      <div className="p-2" style={{ color: 'var(--text-dimmed)', fontSize: 11 }}>
        No dead code found.
      </div>
    );
  }

  const fileEntries = Object.entries(report.byFile);

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-bright)',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          Dead Code
        </span>
        <span
          style={{
            background: 'var(--danger)',
            color: 'var(--bg-primary)',
            fontSize: 10,
            fontWeight: 600,
            padding: '0 4px',
            borderRadius: 'var(--radius)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {report.total} symbols
        </span>
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={handleShowAll}
          style={{
            background: highlighting ? 'var(--accent-dim)' : 'var(--bg-elevated)',
            color: highlighting ? 'var(--accent)' : 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '2px 8px',
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            cursor: 'pointer',
          }}
        >
          Show all on graph
        </button>
        {highlighting && (
          <button
            onClick={handleClear}
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '2px 8px',
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: 'pointer',
            }}
          >
            Clear highlight
          </button>
        )}
      </div>

      {fileEntries.map(([filePath, entries]) => (
        <FileGroup
          key={filePath}
          filePath={filePath}
          entries={entries}
          onSymbolClick={handleSymbolClick}
        />
      ))}
    </div>
  );
}

function FileGroup({
  filePath,
  entries,
  onSymbolClick,
}: {
  filePath: string;
  entries: DeadCodeEntry[];
  onSymbolClick: (filePath: string, entry: DeadCodeEntry) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text-bright)',
          padding: '2px 0',
          fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={filePath}
      >
        {filePath}
      </div>

      {entries.map((entry, idx) => (
        <div
          key={`${entry.name}-${entry.line}-${idx}`}
          onClick={() => onSymbolClick(filePath, entry)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: 10,
            color: 'var(--text-secondary)',
            borderRadius: 'var(--radius)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <TypeBadge label={entry.type} />

          <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
            {entry.name}
          </span>

          <span style={{ color: 'var(--text-dimmed)', fontSize: 9, flexShrink: 0 }}>
            :{entry.line}
          </span>
        </div>
      ))}
    </div>
  );
}
