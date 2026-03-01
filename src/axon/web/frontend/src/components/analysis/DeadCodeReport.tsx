import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeadCodeReport as DeadCodeReportType, DeadCodeEntry } from '@/types';
import { useGraphStore } from '@/stores/graphStore';
import { useViewStore } from '@/stores/viewStore';
import { TypeBadge } from '@/components/shared/TypeBadge';

interface DeadCodeReportProps {
  data: DeadCodeReportType | null;
}

function FileGroup({
  filePath,
  entries,
  expanded,
  onToggle,
  onSymbolClick,
}: {
  filePath: string;
  entries: DeadCodeEntry[];
  expanded: boolean;
  onToggle: () => void;
  onSymbolClick: (filePath: string, entry: DeadCodeEntry) => void;
}) {
  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 0',
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 600,
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--text-bright)',
          userSelect: 'none',
        }}
      >
        <span style={{ width: 12, textAlign: 'center', color: 'var(--text-dimmed)' }}>
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={filePath}
        >
          {filePath}
        </span>
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-dimmed)',
            flexShrink: 0,
          }}
        >
          {entries.length}
        </span>
      </div>

      {expanded &&
        entries.map((entry, idx) => (
          <div
            key={`${entry.name}-${entry.line}-${idx}`}
            onClick={() => onSymbolClick(filePath, entry)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 4px 3px 20px',
              cursor: 'pointer',
              fontSize: 11,
              color: 'var(--text-primary)',
              borderLeft: '2px solid transparent',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.borderLeftColor = 'var(--danger)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderLeftColor = 'transparent';
            }}
          >
            <TypeBadge label={entry.type} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {entry.name}
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-dimmed)',
                fontFamily: "'JetBrains Mono', monospace",
                flexShrink: 0,
              }}
            >
              :{entry.line}
            </span>
          </div>
        ))}
    </div>
  );
}

export function DeadCodeReport({ data }: DeadCodeReportProps) {
  const nodes = useGraphStore((s) => s.nodes);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const fileEntries = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byFile);
  }, [data]);

  useEffect(() => {
    if (fileEntries.length > 0 && expandedFiles.size === 0) {
      setExpandedFiles(new Set(fileEntries.map(([fp]) => fp)));
    }
  }, [fileEntries, expandedFiles.size]);

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleSymbolClick = useCallback(
    (filePath: string, entry: DeadCodeEntry) => {
      const match = nodes.find(
        (n) =>
          n.name === entry.name &&
          n.filePath === filePath &&
          n.startLine === entry.line,
      );
      if (match) {
        setActiveView('explorer');
        selectNode(match.id);
      }
    },
    [nodes, selectNode, setActiveView],
  );

  if (!data) {
    return (
      <div style={{ color: 'var(--text-dimmed)', fontSize: 11, padding: 8 }}>
        Loading...
      </div>
    );
  }

  if (data.total === 0) {
    return (
      <div
        style={{
          padding: 16,
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--accent)',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        No dead code detected
      </div>
    );
  }

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingBottom: 6,
          borderBottom: '1px solid var(--border)',
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--danger)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {data.total} dead symbols
        </span>
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-dimmed)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          across {fileEntries.length} files
        </span>
      </div>

      {fileEntries.map(([filePath, entries]) => (
        <FileGroup
          key={filePath}
          filePath={filePath}
          entries={entries}
          expanded={expandedFiles.has(filePath)}
          onToggle={() => toggleFile(filePath)}
          onSymbolClick={handleSymbolClick}
        />
      ))}
    </div>
  );
}
