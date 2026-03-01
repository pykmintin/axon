import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CouplingPair } from '@/types';

interface CouplingHeatmapProps {
  pairs: CouplingPair[];
}

/** Shorten a full file path to just the filename. */
function shortName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Resolve a CSS variable value from the document. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

export function CouplingHeatmap({ pairs }: CouplingHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
  });
  const [truncated, setTruncated] = useState(false);

  // Build matrix data
  const { files, matrix, pairMap } = useMemo(() => buildMatrix(pairs), [pairs]);

  // Track truncation
  useEffect(() => {
    setTruncated(files.length < getUniqueFiles(pairs).length);
  }, [files.length, pairs]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || files.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const labelWidth = 100;
    const cellSize = Math.max(
      12,
      Math.min(24, (container.clientWidth - labelWidth) / files.length),
    );
    const totalWidth = labelWidth + cellSize * files.length;
    const totalHeight = labelWidth + cellSize * files.length;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    canvas.style.width = `${totalWidth}px`;
    canvas.style.height = `${totalHeight}px`;
    ctx.scale(dpr, dpr);

    // Colors
    const bgColor = cssVar('--bg-surface');
    const borderColor = cssVar('--border');
    const textSecondary = cssVar('--text-secondary');
    const warningColor = cssVar('--warning');

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    // Column labels (rotated)
    ctx.save();
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'left';
    for (let i = 0; i < files.length; i++) {
      const x = labelWidth + i * cellSize + cellSize / 2;
      const y = labelWidth - 4;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 4);
      const label = shortName(files[i]);
      ctx.fillText(label.length > 12 ? label.slice(0, 11) + '\u2026' : label, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // Row labels
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < files.length; i++) {
      const y = labelWidth + i * cellSize + cellSize / 2;
      const label = shortName(files[i]);
      ctx.fillText(
        label.length > 14 ? label.slice(0, 13) + '\u2026' : label,
        labelWidth - 4,
        y,
      );
    }

    // Cells
    for (let row = 0; row < files.length; row++) {
      for (let col = 0; col < files.length; col++) {
        const x = labelWidth + col * cellSize;
        const y = labelWidth + row * cellSize;

        // Grid lines
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, cellSize, cellSize);

        if (row === col) continue; // diagonal empty

        const strength = matrix[row][col];
        if (strength > 0) {
          // Opacity mapped: 0.3->20%, 0.7->60%, 1.0->100%
          const alpha = Math.min(1, Math.max(0.1, strength));
          ctx.fillStyle = warningColor;
          ctx.globalAlpha = alpha;
          ctx.fillRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
          ctx.globalAlpha = 1;
        }
      }
    }
  }, [files, matrix]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || files.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const scaleX = canvas.width / dpr / rect.width;
      const scaleY = canvas.height / dpr / rect.height;
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      const labelWidth = 100;
      const cellSize = Math.max(
        12,
        Math.min(
          24,
          ((containerRef.current?.clientWidth ?? 600) - labelWidth) / files.length,
        ),
      );

      const col = Math.floor((mx - labelWidth) / cellSize);
      const row = Math.floor((my - labelWidth) / cellSize);

      if (
        row >= 0 &&
        row < files.length &&
        col >= 0 &&
        col < files.length &&
        row !== col
      ) {
        const key = pairKey(files[row], files[col]);
        const pair = pairMap.get(key);
        if (pair) {
          setTooltip({
            visible: true,
            x: e.clientX,
            y: e.clientY,
            text: `${shortName(pair.fileA)} \u2194 ${shortName(pair.fileB)} | strength: ${pair.strength.toFixed(2)} | co-changes: ${pair.coChanges}`,
          });
          return;
        }
      }

      setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    },
    [files, pairMap],
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  if (pairs.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--text-dimmed)',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        No coupling data available
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ padding: 8, position: 'relative', overflow: 'auto' }}
    >
      {truncated && (
        <div
          style={{
            fontSize: 9,
            color: 'var(--text-dimmed)',
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 4,
          }}
        >
          Showing top 50 of {getUniqueFiles(pairs).length} files
        </div>
      )}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'block' }}
      />
      {tooltip.visible && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 12,
            top: tooltip.y - 8,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '4px 8px',
            fontSize: 10,
            color: 'var(--text-bright)',
            fontFamily: "'JetBrains Mono', monospace",
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 1000,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pairKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function getUniqueFiles(pairs: CouplingPair[]): string[] {
  const set = new Set<string>();
  for (const p of pairs) {
    set.add(p.fileA);
    set.add(p.fileB);
  }
  return Array.from(set);
}

function buildMatrix(pairs: CouplingPair[]): {
  files: string[];
  matrix: number[][];
  pairMap: Map<string, CouplingPair>;
} {
  if (pairs.length === 0) {
    return { files: [], matrix: [], pairMap: new Map() };
  }

  // Collect unique files
  let allFiles = getUniqueFiles(pairs);

  // If >50 files, pick top 50 by max coupling strength
  if (allFiles.length > 50) {
    const fileMaxStrength = new Map<string, number>();
    for (const p of pairs) {
      fileMaxStrength.set(
        p.fileA,
        Math.max(fileMaxStrength.get(p.fileA) ?? 0, p.strength),
      );
      fileMaxStrength.set(
        p.fileB,
        Math.max(fileMaxStrength.get(p.fileB) ?? 0, p.strength),
      );
    }
    allFiles.sort(
      (a, b) => (fileMaxStrength.get(b) ?? 0) - (fileMaxStrength.get(a) ?? 0),
    );
    allFiles = allFiles.slice(0, 50);
  }

  const fileIndex = new Map<string, number>();
  allFiles.forEach((f, i) => fileIndex.set(f, i));

  const n = allFiles.length;
  const matrix: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );

  const pairMap = new Map<string, CouplingPair>();

  for (const p of pairs) {
    const ri = fileIndex.get(p.fileA);
    const ci = fileIndex.get(p.fileB);
    if (ri != null && ci != null) {
      matrix[ri][ci] = p.strength;
      matrix[ci][ri] = p.strength;
      pairMap.set(pairKey(p.fileA, p.fileB), p);
    }
  }

  return { files: allFiles, matrix, pairMap };
}
