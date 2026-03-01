import { useGraphStore } from '@/stores/graphStore';
import { useDataStore } from '@/stores/dataStore';

export function StatusBar() {
  const overview = useGraphStore((s) => s.overview);
  const communities = useGraphStore((s) => s.communities);
  const deadCode = useDataStore((s) => s.deadCode);
  const healthScore = useDataStore((s) => s.healthScore);

  const nodeCount = overview?.totalNodes ?? 0;
  const communityCount = communities.length;
  const deadCount = deadCode?.total ?? 0;
  const health = healthScore?.score ?? null;

  // Detect primary language from overview
  const language = overview?.nodesByLabel
    ? Object.keys(overview.nodesByLabel).find(
        (k) => !['File', 'Folder', 'Community', 'Process'].includes(k),
      ) ?? '--'
    : '--';

  const pipe = (
    <span
      className="mx-1.5"
      style={{ color: 'var(--text-dimmed)' }}
    >
      &#9474;
    </span>
  );

  return (
    <footer
      className="flex items-center px-3 shrink-0 select-none"
      style={{
        height: 24,
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: 'var(--text-secondary)',
      }}
    >
      <span className="flex items-center gap-1">
        <span style={{ color: nodeCount > 0 ? 'var(--accent)' : 'var(--text-dimmed)' }}>
          &#9679;
        </span>
        <span>{nodeCount > 0 ? 'indexed' : 'no data'}</span>
      </span>

      {pipe}

      <span>{language.toLowerCase()}</span>

      {pipe}

      <span>{communityCount} communities</span>

      {pipe}

      <span>{deadCount} dead</span>

      {pipe}

      <span>health: {health !== null ? health : '--'}</span>
    </footer>
  );
}
