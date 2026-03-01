const ABBREV_MAP: Record<string, string> = {
  function: '\u0192',
  class: 'C',
  method: 'M',
  interface: 'I',
  type_alias: 'T',
  enum: 'E',
};

const COLOR_MAP: Record<string, string> = {
  function: 'var(--node-function)',
  class: 'var(--node-class)',
  method: 'var(--node-method)',
  interface: 'var(--node-interface)',
  type_alias: 'var(--node-typealias)',
  enum: 'var(--node-enum)',
};

interface TypeBadgeProps {
  label: string;
  size?: number;
}

export function TypeBadge({ label, size = 16 }: TypeBadgeProps) {
  const key = label.toLowerCase();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        fontSize: Math.max(9, size - 6),
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        color: COLOR_MAP[key] ?? 'var(--text-secondary)',
        background: 'var(--bg-primary)',
        borderRadius: 'var(--radius)',
        flexShrink: 0,
      }}
    >
      {ABBREV_MAP[key] ?? label.charAt(0).toUpperCase()}
    </span>
  );
}
