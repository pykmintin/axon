import { useEffect, useState } from 'react';
import { analysisApi } from '@/api/client';
import type {
  CouplingPair,
  Process,
} from '@/types';
import { useGraphStore } from '@/stores/graphStore';
import { useDataStore } from '@/stores/dataStore';
import { errorMessage } from '@/lib/utils';
import { HealthScore } from './HealthScore';
import { QuickStats } from './QuickStats';
import { DeadCodeReport } from './DeadCodeReport';
import { CouplingHeatmap } from './CouplingHeatmap';
import { InheritanceTree } from './InheritanceTree';
import { BranchDiff } from './BranchDiff';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const HEADING_STYLE: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--text-bright)',
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  margin: 0,
  flexShrink: 0,
};

const EMPTY_COUPLING: { pairs: CouplingPair[] } = { pairs: [] };
const EMPTY_PROCESSES: { processes: Process[] } = { processes: [] };

function Card({
  title,
  children,
  style,
  loading: isLoading,
}: {
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  loading?: boolean;
}) {
  return (
    <div style={{ ...CARD_STYLE, ...style, position: 'relative' }}>
      <h3 style={HEADING_STYLE}>{title}</h3>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {isLoading ? <LoadingSpinner /> : children}
      </div>
    </div>
  );
}

export function AnalysisView() {
  const overview = useGraphStore((s) => s.overview);
  const communities = useGraphStore((s) => s.communities);
  const healthScore = useDataStore((s) => s.healthScore);
  const deadCode = useDataStore((s) => s.deadCode);

  const [coupling, setCoupling] = useState<CouplingPair[]>([]);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      analysisApi.getCoupling().catch(() => EMPTY_COUPLING),
      analysisApi.getProcesses().catch(() => EMPTY_PROCESSES),
    ])
      .then(([couplingResp, procResp]) => {
        if (cancelled) return;
        setCoupling(couplingResp.pairs);
        setProcesses(procResp.processes);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load analysis data'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div
        style={{
          padding: 16,
          color: 'var(--danger)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
        Failed to load analysis data: {error}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gridTemplateRows: 'auto auto auto',
        gap: 8,
        padding: 8,
        height: '100%',
        overflow: 'auto',
        opacity: 1,
      }}
    >
      <Card title="Health Score">
        <HealthScore data={healthScore} />
      </Card>
      <Card title="Quick Stats" loading={loading}>
        <QuickStats
          overview={overview}
          health={healthScore}
          deadCode={deadCode}
          coupling={coupling}
          communities={communities}
          processes={processes}
        />
      </Card>

      <Card title="Dead Code Report" style={{ gridColumn: 'span 1' }}>
        <DeadCodeReport data={deadCode} />
      </Card>
      <Card title="Coupling Heatmap" style={{ gridColumn: 'span 1' }} loading={loading}>
        <CouplingHeatmap pairs={coupling} />
      </Card>

      <Card title="Inheritance Tree" style={{ gridColumn: 'span 1' }} loading={loading}>
        <InheritanceTree />
      </Card>
      <Card title="Branch Diff" style={{ gridColumn: 'span 1' }} loading={loading}>
        <BranchDiff />
      </Card>
    </div>
  );
}
