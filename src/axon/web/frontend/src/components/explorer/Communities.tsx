import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { analysisApi } from '@/api/client';
import { errorMessage } from '@/lib/utils';
import { useGraphStore } from '@/stores/graphStore';
import type { Community } from '@/types';
import { TypeBadge } from '@/components/shared/TypeBadge';

const COMMUNITY_COLORS = [
  '#39d353',
  '#58a6ff',
  '#a371f7',
  '#3fb8af',
  '#f0883e',
  '#f85149',
  '#d4a72c',
  '#56d4dd',
  '#e5a839',
  '#79c0ff',
  '#d2a8ff',
  '#7ee787',
];

type SortKey = 'name' | 'count' | 'cohesion';

export function Communities() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('count');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    analysisApi
      .getCommunities()
      .then((data) => {
        if (!cancelled) {
          setCommunities(data.communities);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load communities'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => {
    const copy = [...communities];
    switch (sortBy) {
      case 'name':
        copy.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'count':
        copy.sort((a, b) => b.memberCount - a.memberCount);
        break;
      case 'cohesion':
        copy.sort((a, b) => (b.cohesion ?? 0) - (a.cohesion ?? 0));
        break;
    }
    return copy;
  }, [communities, sortBy]);

  if (loading) {
    return (
      <div className="p-2" style={{ color: 'var(--text-secondary)' }}>
        Loading communities...
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

  if (communities.length === 0) {
    return (
      <div className="p-2" style={{ color: 'var(--text-dimmed)', fontSize: 11 }}>
        No communities found.
      </div>
    );
  }

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-secondary)',
            fontFamily: "'IBM Plex Mono', monospace",
            textTransform: 'uppercase',
          }}
        >
          Sort:
        </span>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            padding: '2px 4px',
            outline: 'none',
          }}
        >
          <option value="name">Name</option>
          <option value="count">Count</option>
          <option value="cohesion">Cohesion</option>
        </select>
      </div>

      {sorted.map((community, idx) => (
        <CommunityRow
          key={community.id}
          community={community}
          color={COMMUNITY_COLORS[idx % COMMUNITY_COLORS.length]}
        />
      ))}
    </div>
  );
}

function CommunityRow({
  community,
  color,
}: {
  community: Community;
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const setHighlightedNodes = useGraphStore((s) => s.setHighlightedNodes);
  const nodes = useGraphStore((s) => s.nodes);

  const handleHighlight = useCallback(() => {
    setHighlightedNodes(new Set(community.members));
  }, [community.members, setHighlightedNodes]);

  const memberNodes = useMemo(() => {
    const memberSet = new Set(community.members);
    return nodes.filter((n) => memberSet.has(n.id));
  }, [community.members, nodes]);

  const cohesionPct = Math.round((community.cohesion ?? 0) * 100);

  return (
    <div
      style={{
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}
    >
      <div
        onClick={handleHighlight}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          cursor: 'pointer',
          fontSize: 11,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          {expanded ? (
            <ChevronDown size={12} style={{ color: 'var(--text-secondary)' }} />
          ) : (
            <ChevronRight size={12} style={{ color: 'var(--text-secondary)' }} />
          )}
        </span>

        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 'var(--radius)',
            background: color,
            flexShrink: 0,
          }}
        />

        <span className="truncate" style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>
          {community.name}
        </span>

        <span
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            fontSize: 11,
            padding: '0 4px',
            borderRadius: 'var(--radius)',
            fontFamily: "'JetBrains Mono', monospace",
            flexShrink: 0,
          }}
        >
          {community.memberCount}
        </span>
      </div>

      <div style={{ padding: '0 8px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dimmed)', width: 50, flexShrink: 0 }}>
            cohesion
          </span>
          <div
            style={{
              flex: 1,
              height: 4,
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${cohesionPct}%`,
                height: '100%',
                background: color,
                borderRadius: 'var(--radius)',
              }}
            />
          </div>
          <span style={{ fontSize: 9, color: 'var(--text-dimmed)', width: 28, textAlign: 'right', flexShrink: 0 }}>
            {cohesionPct}%
          </span>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '4px 0',
          }}
        >
          {memberNodes.length === 0 ? (
            <div style={{ padding: '2px 8px 2px 28px', fontSize: 10, color: 'var(--text-dimmed)' }}>
              No resolved members in graph.
            </div>
          ) : (
            memberNodes.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MemberRow({ member }: { member: { id: string; name: string; label: string } }) {
  const selectNode = useGraphStore((s) => s.selectNode);

  return (
    <div
      onClick={() => selectNode(member.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px 2px 28px',
        cursor: 'pointer',
        fontSize: 10,
        color: 'var(--text-secondary)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <TypeBadge label={member.label} />
      <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
        {member.name}
      </span>
    </div>
  );
}
