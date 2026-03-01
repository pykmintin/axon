import { useEffect, useState, useCallback, useMemo } from 'react';
import { analysisApi } from '@/api/client';
import { useDataStore } from '@/stores/dataStore';
import { useGraphStore } from '@/stores/graphStore';
import type { Process } from '@/types';
import { ChevronDown, ChevronRight, Route, Highlighter } from 'lucide-react';
import { TypeBadge } from '@/components/shared/TypeBadge';
import { shortPath } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Kind badge
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: string | null }) {
  const isCross = kind === 'cross';
  const color = isCross ? 'var(--purple)' : 'var(--cyan)';
  const label = isCross ? 'cross' : 'intra';

  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        borderRadius: 'var(--radius)',
        padding: '0 3px',
        fontFamily: "'JetBrains Mono', monospace",
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Process entry with expandable steps
// ---------------------------------------------------------------------------

function ProcessEntry({
  process,
  allNodes,
}: {
  process: Process;
  allNodes: Map<string, { name: string; label: string; filePath: string; startLine: number }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const setFlowTrace = useGraphStore((s) => s.setFlowTrace);
  const setHighlightedNodes = useGraphStore((s) => s.setHighlightedNodes);

  const Chevron = expanded ? ChevronDown : ChevronRight;

  const stepNodeIds = process.steps
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((s) => s.nodeId);

  const handleTrace = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setFlowTrace(stepNodeIds);
    },
    [stepNodeIds, setFlowTrace],
  );

  const handleHighlight = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setHighlightedNodes(new Set(stepNodeIds));
    },
    [stepNodeIds, setHighlightedNodes],
  );

  return (
    <div style={{ marginBottom: 2 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 0',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--text-primary)',
          textAlign: 'left',
        }}
      >
        <Chevron size={12} style={{ color: 'var(--text-dimmed)', flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={process.name}
        >
          {process.name}
        </span>
        <KindBadge kind={process.kind} />
        <span style={{ color: 'var(--text-dimmed)', fontSize: 10, flexShrink: 0 }}>
          {process.stepCount} steps
        </span>
      </button>

      <div style={{ display: 'flex', gap: 4, paddingLeft: 16, marginBottom: 2 }}>
        <button
          onClick={handleTrace}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '1px 4px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
          }}
        >
          <Route size={9} />
          Trace
        </button>
        <button
          onClick={handleHighlight}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '1px 4px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
          }}
        >
          <Highlighter size={9} />
          Highlight
        </button>
      </div>

      {expanded && (
        <div style={{ paddingLeft: 16, paddingBottom: 4 }}>
          {process.steps
            .sort((a, b) => a.stepNumber - b.stepNumber)
            .map((step) => {
              const nodeInfo = allNodes.get(step.nodeId);
              return (
                <StepRow
                  key={step.nodeId + '-' + step.stepNumber}
                  stepNumber={step.stepNumber}
                  nodeId={step.nodeId}
                  nodeInfo={nodeInfo}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step row
// ---------------------------------------------------------------------------

function StepRow({
  stepNumber,
  nodeId,
  nodeInfo,
}: {
  stepNumber: number;
  nodeId: string;
  nodeInfo?: { name: string; label: string; filePath: string; startLine: number };
}) {
  const selectNode = useGraphStore((s) => s.selectNode);

  return (
    <button
      onClick={() => selectNode(nodeId)}
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
        fontSize: 10,
        color: 'var(--text-primary)',
        textAlign: 'left',
      }}
    >
      <span style={{ color: 'var(--text-dimmed)', width: 16, textAlign: 'right', flexShrink: 0 }}>
        {stepNumber}.
      </span>
      {nodeInfo ? (
        <>
          <TypeBadge label={nodeInfo.label} />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {nodeInfo.name}
          </span>
          <span style={{ color: 'var(--text-dimmed)', fontSize: 9, flexShrink: 0 }}>
            {shortPath(nodeInfo.filePath)}:{nodeInfo.startLine}
          </span>
        </>
      ) : (
        <span style={{ color: 'var(--text-dimmed)', fontStyle: 'italic' }}>
          {nodeId}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ProcessesTabProps {
  nodeId: string;
}

export function ProcessesTab({ nodeId }: ProcessesTabProps) {
  const allProcesses = useDataStore((s) => s.allProcesses);
  const setAllProcesses = useDataStore((s) => s.setAllProcesses);
  const loading = useDataStore((s) => s.loading);
  const setLoading = useDataStore((s) => s.setLoading);
  const graphNodes = useGraphStore((s) => s.nodes);

  const [error, setError] = useState<string | null>(null);

  // Build a quick-lookup map from graphStore nodes
  const nodeMap = useMemo(() => {
    const map = new Map<string, { name: string; label: string; filePath: string; startLine: number }>();
    for (const n of graphNodes) {
      map.set(n.id, { name: n.name, label: n.label, filePath: n.filePath, startLine: n.startLine });
    }
    return map;
  }, [graphNodes]);

  // Fetch all processes if not already loaded
  const fetchProcesses = useCallback(async () => {
    if (allProcesses) return;
    setLoading('processes', true);
    setError(null);
    try {
      const result = await analysisApi.getProcesses();
      setAllProcesses(result.processes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processes');
    } finally {
      setLoading('processes', false);
    }
  }, [allProcesses, setAllProcesses, setLoading]);

  useEffect(() => {
    void fetchProcesses();
  }, [fetchProcesses]);

  // Filter processes that involve the selected node
  const { relevantProcesses, crossProcesses, intraProcesses } = useMemo(() => {
    const relevant = (allProcesses ?? []).filter((p: Process) =>
      p.steps.some((s) => s.nodeId === nodeId),
    );
    return {
      relevantProcesses: relevant,
      crossProcesses: relevant.filter((p: Process) => p.kind === 'cross'),
      intraProcesses: relevant.filter((p: Process) => p.kind !== 'cross'),
    };
  }, [allProcesses, nodeId]);

  if (loading['processes']) {
    return (
      <div className="p-2" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
        <span style={{ color: 'var(--accent)' }}>{'\u25CF'}</span> Loading...
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

  if (relevantProcesses.length === 0) {
    return (
      <div
        className="p-2"
        style={{
          color: 'var(--text-dimmed)',
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        No processes involve this node
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", padding: 8 }}>
      {crossProcesses.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="section-heading" style={{ fontSize: 11, marginBottom: 4 }}>
            CROSS-COMMUNITY FLOWS ({crossProcesses.length})
          </div>
          {crossProcesses.map((p: Process) => (
            <ProcessEntry key={p.name} process={p} allNodes={nodeMap} />
          ))}
        </div>
      )}

      {intraProcesses.length > 0 && (
        <div>
          <div className="section-heading" style={{ fontSize: 11, marginBottom: 4 }}>
            INTRA-COMMUNITY FLOWS ({intraProcesses.length})
          </div>
          {intraProcesses.map((p: Process) => (
            <ProcessEntry key={p.name} process={p} allNodes={nodeMap} />
          ))}
        </div>
      )}
    </div>
  );
}
