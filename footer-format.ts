export type ContextUsageBand = "low" | "medium" | "near-limit" | "unknown";

export function contextUsageBand(percent: number | null | undefined): ContextUsageBand {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "unknown";
  if (percent >= 85) return "near-limit";
  if (percent >= 60) return "medium";
  return "low";
}

export function buildContextMeter(percent: number | null | undefined, units = 12): string {
  const safeUnits = Math.max(1, Math.floor(units));
  if (percent === null || percent === undefined || !Number.isFinite(percent)) {
    return "░".repeat(safeUnits);
  }
  const normalized = Math.max(0, Math.min(100, percent));
  const filled = normalized === 100 ? safeUnits : Math.floor((normalized / 100) * safeUnits);
  return `${"█".repeat(filled)}${"░".repeat(safeUnits - filled)}`;
}

export function formatSessionClock(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
