/** CLI value parsers (PRD §5, §9): "25m", "5b", "250000", dates. */
export function parseAbbrevNumber(v?: string): number | undefined {
  if (v == null) return undefined;
  const m = String(v).trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)\s*([kmbt])?$/);
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const base = Number(m[1]);
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return m[2] ? base * (mult[m[2]] ?? 1) : base;
}

export function parseList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function todayIso(): string {
  return new Date().toISOString();
}
