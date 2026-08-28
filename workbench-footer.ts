import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentDashboardState,
  isFinishedStatus,
  type AgentDashboardGroup,
  type AgentDashboardJob,
} from "./dashboard-state.ts";
import { buildContextMeter, contextUsageBand, formatSessionClock } from "./footer-format.ts";

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatJobElapsed(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function findSessionStart(ctx: ExtensionContext): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of ctx.sessionManager.getEntries()) {
    const timestamp = parseTimestamp((entry as { timestamp?: unknown }).timestamp);
    if (timestamp !== undefined) earliest = Math.min(earliest, timestamp);
  }
  return Number.isFinite(earliest) ? earliest : Date.now();
}

function isActive(job: AgentDashboardJob): boolean {
  return !isFinishedStatus(job.status);
}

function statusIcon(job: AgentDashboardJob, theme: Theme): string {
  switch (job.status) {
    case "completed": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "∅");
    case "paused": return theme.fg("warning", "Ⅱ");
    case "steering": return theme.fg("accent", "↻");
    case "retrying": return theme.fg("warning", "↺");
    case "running": return theme.fg("accent", "●");
    default: return theme.fg("dim", "○");
  }
}

function statusLabel(job: AgentDashboardJob): string {
  if (job.status === "steering") return "steering";
  if (job.status === "retrying") return "retrying";
  return job.status;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const usage = (entry.message as { usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    } }).usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals;
}

function divider(theme: Theme): string {
  return theme.fg("borderMuted", " │ ");
}

function joinParts(parts: string[], theme: Theme, width: number): string {
  return truncateToWidth(parts.join(divider(theme)), width, "...");
}

function alignSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "...");
  if (!left) return truncateToWidth(right, width, "...");

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "...");

  const fittedLeft = truncateToWidth(left, Math.max(1, width - rightWidth - 1), "...");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
  return truncateToWidth(fittedLeft + gap + right, width, "...");
}

function renderModel(ctx: ExtensionContext, theme: Theme, includeProvider: boolean): string {
  const modelName = ctx.model?.name ?? ctx.model?.id ?? "No model";
  const provider = ctx.model?.provider ?? "unknown";
  const name = theme.fg("accent", theme.bold(modelName));
  return includeProvider ? `${theme.fg("dim", `[${provider}]`)} ${name}` : name;
}

function renderContext(percent: number | null | undefined, theme: Theme, compact: boolean): string {
  const label = percent === null || percent === undefined ? "--%" : `${Math.round(percent)}%`;
  const band = contextUsageBand(percent);
  const color = band === "near-limit"
    ? "error"
    : band === "medium"
      ? "warning"
      : band === "low"
        ? "success"
        : "muted";
  const coloredLabel = theme.fg(color, label);
  if (compact) return `${theme.fg("dim", "ctx")} ${coloredLabel}`;

  const meter = buildContextMeter(percent, 12);
  const filledCount = meter.indexOf("░") === -1 ? meter.length : meter.indexOf("░");
  const filled = meter.slice(0, filledCount);
  const empty = meter.slice(filledCount);
  return `${theme.fg(color, filled)}${theme.fg("dim", empty)} ${coloredLabel}`;
}

function renderOverviewFooter(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: any,
  width: number,
  sessionStartedAt: number,
): string[] {
  const branch = footerData.getGitBranch?.() as string | null | undefined;
  const project = path.basename(ctx.cwd) || ctx.cwd;
  const model = renderModel(ctx, theme, width >= 76);
  const location = `${theme.fg("mdLink", "📁")} ${theme.fg("text", project)}`;
  const branchPart = branch
    ? `${theme.fg("success", "🌿")} ${theme.fg("muted", branch)}`
    : "";

  const firstParts = width < 48
    ? [model, location]
    : [model, location, branchPart].filter(Boolean);

  const usage = collectUsage(ctx);
  const context = ctx.getContextUsage?.();
  const contextPart = renderContext(context?.percent, theme, width < 58);
  const costPart = theme.fg("warning", `$${usage.cost.toFixed(3)}`);
  const clockPart = `${theme.fg("muted", "⏱")} ${theme.fg("muted", formatSessionClock(sessionStartedAt))}`;
  const tokenPart = theme.fg("dim", `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`);
  const secondParts = width >= 96
    ? [contextPart, costPart, clockPart, tokenPart]
    : width >= 46
      ? [contextPart, costPart, clockPart]
      : [contextPart, costPart];

  return [
    joinParts(firstParts, theme, width),
    joinParts(secondParts, theme, width),
  ];
}

function renderDashboardStatus(
  theme: Theme,
  footerData: any,
  dashboard: AgentDashboardState,
  width: number,
): string | undefined {
  const activeCount = dashboard.getActiveGroups()
    .flatMap((group) => group.jobs)
    .filter(isActive).length;
  const finishedCount = dashboard.finishedCount;
  const statusMap = footerData.getExtensionStatuses?.() as ReadonlyMap<string, string> | undefined;
  const statuses = statusMap ? [...statusMap.values()].filter(Boolean) : [];

  if (activeCount === 0 && finishedCount === 0 && statuses.length === 0) return undefined;

  const leftParts = statuses.map((status) => theme.fg("muted", status));
  if (activeCount > 0 || finishedCount > 0) {
    leftParts.push(theme.fg("dim", dashboard.isFocused() ? "Ctrl+Alt+A / Esc close agent dashboard" : "Ctrl+Alt+A agent dashboard"));
  }

  const rightParts: string[] = [];
  if (activeCount > 0) {
    rightParts.push(theme.fg("accent", `← ${activeCount} agent${activeCount === 1 ? "" : "s"}`));
  }
  if (finishedCount > 0) {
    rightParts.push(theme.fg("success", `✓ ${finishedCount} finished`));
  }

  return alignSides(leftParts.join(theme.fg("borderMuted", " · ")), rightParts.join("  "), width);
}

function cardText(job: AgentDashboardJob, selected: boolean, theme: Theme): string {
  const title = job.title.length > 18 ? `${job.title.slice(0, 17)}…` : job.title;
  const queued = job.queuedMessages.length > 0 ? ` +${job.queuedMessages.length}` : "";
  const label = `${statusIcon(job, theme)} ${title} ${theme.fg("muted", statusLabel(job))}${queued} ${theme.fg("dim", formatJobElapsed(job.startedAt, job.finishedAt))}`;
  return selected ? theme.bg("selectedBg", theme.fg("accent", ` ${label} `)) : ` ${label} `;
}

function renderGroup(
  group: AgentDashboardGroup,
  state: AgentDashboardState,
  theme: Theme,
  width: number,
  kind: "active" | "finished",
): string[] {
  const jobs = group.jobs.filter((job) => kind === "active" ? isActive(job) : isFinishedStatus(job.status));
  if (jobs.length === 0) return [];

  const selectedId = state.getSelectedJob()?.id;
  const marker = group.collapsed ? "▸" : "▾";
  const label = kind === "active" ? `${jobs.length} active` : `${jobs.length} finished`;
  const header = theme.fg("muted", `${marker} ${group.title} (${label})`);
  const lines = [truncateToWidth(header, width, "...")];
  if (group.collapsed) return lines;

  const cards = jobs.map((job) => cardText(job, job.id === selectedId, theme));
  let row = cards.join(theme.fg("borderMuted", "│"));
  if (visibleWidth(row) > width) {
    const selectedIndex = Math.max(0, jobs.findIndex((job) => job.id === selectedId));
    let start = selectedIndex;
    let end = selectedIndex + 1;
    while (end < cards.length && visibleWidth(cards.slice(start, end + 1).join("│")) <= width) end++;
    while (start > 0 && visibleWidth(cards.slice(start - 1, end).join("│")) <= width) start--;
    row = `${start > 0 ? "…" : ""}${cards.slice(start, end).join(theme.fg("borderMuted", "│"))}${end < cards.length ? "…" : ""}`;
  }
  lines.push(truncateToWidth(row, width, "..."));
  return lines;
}

export class WorkbenchFooterComponent implements Component {
  private readonly unsubscribe: () => void;
  private readonly branchUnsubscribe: () => void;
  private readonly clockTimer: ReturnType<typeof setInterval>;
  private readonly sessionStartedAt: number;

  constructor(
    private readonly tui: TUI,
    private readonly ctx: ExtensionContext,
    private readonly theme: Theme,
    private readonly footerData: any,
    private readonly dashboard: AgentDashboardState,
  ) {
    this.sessionStartedAt = findSessionStart(ctx);
    this.unsubscribe = dashboard.subscribe(() => tui.requestRender());
    this.branchUnsubscribe = footerData.onBranchChange?.(() => tui.requestRender()) ?? (() => {});
    this.clockTimer = setInterval(() => tui.requestRender(), 1000);
  }

  render(width: number): string[] {
    const lines = renderOverviewFooter(
      this.ctx,
      this.theme,
      this.footerData,
      width,
      this.sessionStartedAt,
    );

    const dashboardStatus = renderDashboardStatus(this.theme, this.footerData, this.dashboard, width);
    if (dashboardStatus) lines.push(dashboardStatus);

    if (this.dashboard.isFocused()) {
      lines.push(this.theme.fg("dim", "↑↓ groups · ←→ agents · Enter open · Space collapse · Esc close"));
      for (const group of this.dashboard.getActiveGroups()) {
        lines.push(...renderGroup(group, this.dashboard, this.theme, width, "active"));
      }

      if (this.dashboard.finishedCount > 0) {
        const marker = this.dashboard.isFinishedExpanded() ? "▾" : "▸";
        lines.push(this.theme.fg("muted", `${marker} Finished (${this.dashboard.finishedCount})`));
        if (this.dashboard.isFinishedExpanded()) {
          for (const group of this.dashboard.getFinishedGroups()) {
            lines.push(...renderGroup(group, this.dashboard, this.theme, width, "finished"));
          }
        }
      }
    }

    return lines.map((line) => truncateToWidth(line, width, "..."));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.clockTimer);
    this.unsubscribe();
    this.branchUnsubscribe();
  }
}

export function createWorkbenchFooter(
  ctx: ExtensionContext,
  dashboard: AgentDashboardState,
): (tui: TUI, theme: Theme, footerData: any) => WorkbenchFooterComponent {
  return (tui, theme, footerData) => new WorkbenchFooterComponent(tui, ctx, theme, footerData, dashboard);
}
