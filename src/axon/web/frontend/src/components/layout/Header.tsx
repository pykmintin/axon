import { RotateCw } from 'lucide-react';
import { useGraphStore } from '@/stores/graphStore';
import { useViewStore, type ActiveView } from '@/stores/viewStore';
import { cn } from '@/lib/utils';

const tabs: { id: ActiveView; label: string }[] = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'cypher', label: 'Cypher' },
];

export function Header() {
  const overview = useGraphStore((s) => s.overview);
  const activeView = useViewStore((s) => s.activeView);
  const setActiveView = useViewStore((s) => s.setActiveView);
  const toggleCommandPalette = useViewStore((s) => s.toggleCommandPalette);

  const nodeCount = overview?.totalNodes ?? 0;
  const edgeCount = overview?.totalEdges ?? 0;

  return (
    <header
      className="flex items-center justify-between px-3 shrink-0 select-none"
      style={{
        height: 40,
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-2">
        <img
          src="/axon-logo.png"
          alt="Axon"
          className="h-6 w-auto"
        />
        <span
          className="view-title"
          style={{ color: 'var(--accent)', fontSize: 14 }}
        >
          AXON
        </span>
      </div>

      <nav className="flex items-center gap-0 h-full">
        {tabs.map((tab) => {
          const isActive = activeView === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveView(tab.id)}
              className={cn(
                'h-full px-3 text-[11px] font-medium uppercase tracking-wide',
                'transition-colors duration-100 cursor-pointer',
                'border-b-2 border-transparent',
                'bg-transparent outline-none',
              )}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                color: isActive ? 'var(--text-bright)' : 'var(--text-secondary)',
                borderBottomColor: isActive ? 'var(--accent)' : 'transparent',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <span
          className="text-[11px]"
          style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          {nodeCount.toLocaleString()}{' '}
          <span style={{ color: 'var(--accent)' }}>&#9679;</span>
        </span>

        <span
          className="text-[11px]"
          style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          {edgeCount.toLocaleString()}{' '}
          <span style={{ color: 'var(--text-dimmed)' }}>&#9472;</span>
        </span>

        <button
          onClick={toggleCommandPalette}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] cursor-pointer bg-transparent"
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-dimmed)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span>&#8984;K</span>
        </button>

        <button
          className="flex items-center justify-center p-1 cursor-pointer bg-transparent border-0"
          style={{ color: 'var(--text-secondary)' }}
          title="Reindex"
        >
          <RotateCw size={13} />
        </button>
      </div>
    </header>
  );
}
