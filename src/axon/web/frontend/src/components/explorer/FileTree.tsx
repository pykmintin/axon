import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder } from 'lucide-react';
import { fileApi } from '@/api/client';
import { errorMessage } from '@/lib/utils';
import { useGraphStore } from '@/stores/graphStore';
import type { FolderNode } from '@/types';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';

const LANGUAGE_COLOR: Record<string, string> = {
  typescript: 'var(--info)',
  javascript: 'var(--warning)',
  python: 'var(--node-function)',
  rust: 'var(--orange)',
  go: 'var(--cyan)',
  java: 'var(--danger)',
  css: 'var(--purple)',
  html: 'var(--orange)',
  json: 'var(--text-secondary)',
};

function langColor(lang: string | null | undefined): string {
  if (!lang) return 'var(--text-dimmed)';
  return LANGUAGE_COLOR[lang.toLowerCase()] ?? 'var(--text-secondary)';
}

export function FileTree() {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fileApi
      .getTree()
      .then((data) => {
        if (!cancelled) {
          setTree(data.tree);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load file tree'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTree = useMemo(() => {
    if (!filter.trim()) return tree;
    const term = filter.toLowerCase();
    return filterNodes(tree, term);
  }, [tree, filter]);

  if (loading) {
    return (
      <div className="p-4">
        <LoadingSpinner message="Loading file tree..." />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-2"
        style={{
          color: 'var(--danger)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
        }}
      >
        {error}
      </div>
    );
  }

  if (tree.length === 0) {
    return <EmptyState message="No files indexed" />;
  }

  return (
    <div className="flex flex-col h-full">
      <div style={{ padding: 8 }}>
        <input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            padding: '4px 8px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ padding: '0 4px 8px' }}>
        {filteredTree.length === 0 ? (
          <div style={{ color: 'var(--text-dimmed)', padding: '4px 8px', fontSize: 11 }}>
            No files found.
          </div>
        ) : (
          filteredTree.map((node) => (
            <TreeNode key={node.path} node={node} depth={0} />
          ))
        )}
      </div>
    </div>
  );
}

function filterNodes(nodes: FolderNode[], term: string): FolderNode[] {
  const result: FolderNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(term) || node.path.toLowerCase().includes(term)) {
        result.push(node);
      }
    } else {
      const filteredChildren = filterNodes(node.children ?? [], term);
      if (
        filteredChildren.length > 0 ||
        node.name.toLowerCase().includes(term)
      ) {
        result.push({ ...node, children: filteredChildren });
      }
    }
  }
  return result;
}

function setsMatch(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function TreeNode({ node, depth }: { node: FolderNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setHighlightedNodes = useGraphStore((s) => s.setHighlightedNodes);
  const highlightedNodeIds = useGraphStore((s) => s.highlightedNodeIds);
  const nodes = useGraphStore((s) => s.nodes);

  const isFolder = node.type === 'folder';
  const targetNodeIds = useMemo(() => {
    if (isFolder) {
      const prefix = node.path.endsWith('/') ? node.path : `${node.path}/`;
      return new Set(
        nodes.filter((n) => n.filePath?.startsWith(prefix)).map((n) => n.id),
      );
    }

    return new Set(
      nodes.filter((n) => n.filePath === node.path).map((n) => n.id),
    );
  }, [isFolder, node.path, nodes]);

  const isActive = useMemo(
    () => setsMatch(targetNodeIds, highlightedNodeIds),
    [targetNodeIds, highlightedNodeIds],
  );

  const handleClick = useCallback(() => {
    if (isFolder) {
      setExpanded((prev) => !prev);
    }

    if (isActive) {
      setHighlightedNodes(new Set());
      return;
    }

    if (targetNodeIds.size > 0) {
      selectNode(null);
      setHighlightedNodes(targetNodeIds);
    }
  }, [isFolder, isActive, selectNode, setHighlightedNodes, targetNodeIds]);

  const fileSymbols = useMemo(() => {
    if (isFolder) return [];
    return nodes.filter((n) => n.filePath === node.path);
  }, [isFolder, nodes, node.path]);

  const [symbolsExpanded, setSymbolsExpanded] = useState(false);

  return (
    <div>
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          paddingLeft: 8 + depth * 12,
          cursor: 'pointer',
          fontSize: 11,
          color: isActive ? 'var(--text-bright)' : 'var(--text-primary)',
          borderRadius: 'var(--radius)',
          background: isActive
            ? 'color-mix(in srgb, var(--accent) 22%, var(--bg-surface))'
            : 'transparent',
          boxShadow: isActive
            ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 75%, transparent), inset 2px 0 0 0 var(--accent)'
            : 'none',
          transition: 'background 120ms ease, box-shadow 120ms ease, color 120ms ease',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = 'var(--bg-hover)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isActive
            ? 'color-mix(in srgb, var(--accent) 22%, var(--bg-surface))'
            : 'transparent';
        }}
      >
        {isFolder ? (
          <>
            {expanded ? (
              <ChevronDown
                size={12}
                style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)', flexShrink: 0 }}
              />
            ) : (
              <ChevronRight
                size={12}
                style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)', flexShrink: 0 }}
              />
            )}
            <Folder
              size={12}
              style={{ color: isActive ? 'var(--accent)' : 'var(--node-folder)', flexShrink: 0 }}
            />
          </>
        ) : (
          <>
            {fileSymbols.length > 0 ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setSymbolsExpanded((prev) => !prev);
                }}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
              >
                {symbolsExpanded ? (
                  <ChevronDown size={12} style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }} />
                ) : (
                  <ChevronRight size={12} style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }} />
                )}
              </span>
            ) : (
              <span style={{ width: 12, flexShrink: 0 }} />
            )}
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: isActive ? 'var(--accent)' : langColor(node.language),
                boxShadow: isActive ? '0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)' : 'none',
                flexShrink: 0,
              }}
            />
          </>
        )}

        <span
          className="truncate"
          style={{
            flex: 1,
            minWidth: 0,
            color: isActive
              ? 'var(--text-bright)'
              : isFolder
                ? 'var(--text-bright)'
                : 'var(--text-primary)',
            fontWeight: isActive ? 600 : 400,
          }}
        >
          {node.name}
        </span>

        {isFolder && node.children && node.children.length > 0 && (
          <Badge active={isActive}>{node.children.length}</Badge>
        )}
        {!isFolder && node.symbolCount != null && node.symbolCount > 0 && (
          <Badge active={isActive}>{node.symbolCount}</Badge>
        )}
      </div>

      {isFolder && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}

      {!isFolder && symbolsExpanded && fileSymbols.length > 0 && (
        <div>
          {fileSymbols.map((sym) => (
            <SymbolRow key={sym.id} symbol={sym} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function SymbolRow({
  symbol,
  depth,
}: {
  symbol: { id: string; name: string; label: string; startLine: number };
  depth: number;
}) {
  const selectNode = useGraphStore((s) => s.selectNode);

  return (
    <div
      onClick={() => selectNode(symbol.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        paddingLeft: 8 + depth * 12 + 12,
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
      <span
        style={{
          color: nodeTypeColor(symbol.label),
          fontWeight: 600,
          fontSize: 9,
          width: 12,
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {nodeTypeAbbrev(symbol.label)}
      </span>
      <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
        {symbol.name}
      </span>
      <span style={{ color: 'var(--text-dimmed)', fontSize: 9, flexShrink: 0 }}>
        :{symbol.startLine}
      </span>
    </div>
  );
}

function Badge({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      style={{
        background: active
          ? 'color-mix(in srgb, var(--accent) 18%, var(--bg-elevated))'
          : 'var(--bg-elevated)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 11,
        padding: '0 4px',
        borderRadius: 'var(--radius)',
        fontFamily: "'JetBrains Mono', monospace",
        flexShrink: 0,
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </span>
  );
}

function nodeTypeAbbrev(label: string): string {
  switch (label.toLowerCase()) {
    case 'function':
      return '\u0192';
    case 'class':
      return 'C';
    case 'method':
      return 'M';
    case 'interface':
      return 'I';
    case 'type_alias':
      return 'T';
    case 'enum':
      return 'E';
    default:
      return label.charAt(0).toUpperCase();
  }
}

function nodeTypeColor(label: string): string {
  const map: Record<string, string> = {
    function: 'var(--node-function)',
    class: 'var(--node-class)',
    method: 'var(--node-method)',
    interface: 'var(--node-interface)',
    type_alias: 'var(--node-typealias)',
    enum: 'var(--node-enum)',
  };
  return map[label.toLowerCase()] ?? 'var(--text-secondary)';
}
