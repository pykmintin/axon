import { useMemo } from 'react';
import type { HealthScore as HealthScoreType } from '@/types';

interface HealthScoreProps {
  data: HealthScoreType | null;
}

const METRIC_LABELS: { key: keyof HealthScoreType['breakdown']; label: string }[] = [
  { key: 'deadCode', label: 'Dead Code' },
  { key: 'coupling', label: 'Coupling' },
  { key: 'modularity', label: 'Modularity' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'coverage', label: 'Coverage' },
];

function scoreColor(value: number): string {
  if (value >= 80) return 'var(--accent)';
  if (value >= 50) return 'var(--warning)';
  return 'var(--danger)';
}

function ProgressRing({ score, size = 120 }: { score: number; size?: number }) {
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreColor(score);

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="butt"
      />
    </svg>
  );
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const color = scoreColor(value);
  const pct = Math.max(0, Math.min(100, value));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 80,
          fontSize: 10,
          color: 'var(--text-secondary)',
          fontFamily: "'JetBrains Mono', monospace",
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        style={{
          width: 28,
          fontSize: 10,
          fontWeight: 600,
          color,
          fontFamily: "'JetBrains Mono', monospace",
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {Math.round(value)}
      </span>
    </div>
  );
}

export function HealthScore({ data }: HealthScoreProps) {
  const score = useMemo(() => (data ? Math.round(data.score) : 0), [data]);
  const color = scoreColor(score);

  if (!data) {
    return (
      <div style={{ color: 'var(--text-dimmed)', fontSize: 11, padding: 8 }}>
        Loading health score...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          height: 120,
        }}
      >
        <ProgressRing score={score} />
        <span
          style={{
            position: 'absolute',
            fontSize: 48,
            fontWeight: 700,
            fontFamily: "'IBM Plex Mono', monospace",
            color,
            lineHeight: 1,
          }}
        >
          {score}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {METRIC_LABELS.map(({ key, label }) => (
          <MetricBar key={key} label={label} value={data.breakdown[key]} />
        ))}
      </div>
    </div>
  );
}
