import { useState, useCallback } from 'react';
import { cypherApi } from '@/api/client';
import { useDataStore } from '@/stores/dataStore';
import { errorMessage } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { ResultsTable } from './ResultsTable';

export function CypherView() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cypherResult = useDataStore((s) => s.cypherResult);
  const setCypherResult = useDataStore((s) => s.setCypherResult);
  const addCypherHistory = useDataStore((s) => s.addCypherHistory);

  const execute = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);

    try {
      const result = await cypherApi.execute(trimmed);
      setCypherResult(result);
      addCypherHistory(trimmed);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Query execution failed'));
      setCypherResult(null);
    } finally {
      setLoading(false);
    }
  }, [query, loading, setCypherResult, addCypherHistory]);

  return (
    <div className="flex h-full">
      <div
        className="flex flex-col h-full"
        style={{ width: '50%', minWidth: 0 }}
      >
        <div
          className="shrink-0 p-2"
          style={{
            height: 200,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <QueryEditor
            value={query}
            onChange={setQuery}
            onExecute={execute}
            loading={loading}
          />
        </div>

        <div className="flex-1 min-h-0">
          <ResultsTable result={cypherResult} error={error} />
        </div>
      </div>

      <div
        style={{
          width: 1,
          background: 'var(--border)',
          flexShrink: 0,
        }}
      />

      <div
        className="flex items-center justify-center"
        style={{ width: '50%', minWidth: 0 }}
      >
        <span
          className="text-[11px]"
          style={{
            color: 'var(--text-dimmed)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Graph preview — matching nodes highlighted
        </span>
      </div>
    </div>
  );
}
