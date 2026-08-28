import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboardState, isFinishedStatus, type AgentDashboardJob } from "./dashboard-state.ts";

export interface AgentOverlayActions {
  cancelRun(): void;
  copy(job: AgentDashboardJob): void;
  requestRender(): void;
}

type FocusZone = "output" | "input" | "actions";

function toolLine(job: AgentDashboardJob, index: number, selectedIndex: number, theme: Theme): string {
  const tool = job.tools[index];
  if (!tool) return "";
  const selected = index === selectedIndex ? theme.fg("accent", "▸") : " ";
  const state = tool.isError ? theme.fg("error", "✗") : tool.finishedAt ? theme.fg("success", "✓") : theme.fg("warning", "●");
  const expansion = tool.expanded ? "▾" : "▸";
  const args = JSON.stringify(tool.args);
  const preview = args.length > 90 ? `${args.slice(0, 87)}...` : args;
  return `${selected}${expansion} ${state} ${theme.fg("accent", tool.name)} ${theme.fg("dim", preview)}`;
}

function transcriptLines(job: AgentDashboardJob, theme: Theme): string[] {
  const lines: string[] = [];
  for (const item of job.transcript) {
    const label = item.kind === "assistant" ? "agent" : item.kind;
    const color = item.kind === "assistant" ? "text" : item.kind === "user" ? "accent" : "muted";
    const text = item.text || "(no output)";
    for (const line of text.split("\n")) lines.push(`${theme.fg(color as any, label.padEnd(7))} ${line}`);
  }
  if (job.output && !job.transcript.some((item) => item.text === job.output)) {
    for (const line of job.output.split("\n")) lines.push(`${theme.fg("text", "agent".padEnd(7))} ${line}`);
  }
  return lines;
}

export class AgentDetailOverlay implements Component, Focusable {
  focused = false;
  private zone: FocusZone = "input";
  private scrollOffset = 0;
  private selectedToolIndex = 0;
  private followTail = true;
  private lastTranscriptLength = 0;
  private metadata = false;
  private readonly input = new Input();
  private readonly backdrop: OverlayHandle;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly dashboard: AgentDashboardState,
    private readonly jobId: string,
    private readonly actions: AgentOverlayActions,
    private readonly done: () => void,
  ) {
    this.backdrop = tui.showOverlay(new DimBackdrop(theme), {
      nonCapturing: true,
      row: 0,
      col: 0,
      width: "100%",
      maxHeight: "100%",
    });
    this.input.onSubmit = (value) => {
      const job = this.job;
      if (!job || isFinishedStatus(job.status) || job.status === "paused" || !value.trim()) return;
      const control = dashboard.control(job.id);
      if (job.status === "waiting_for_parent" && job.question && control?.answer) {
        control.answer(job.question.id, value.trim());
      } else {
        control?.steer(value.trim());
      }
      dashboard.addTranscript(job.id, { kind: "user", text: value.trim(), timestamp: Date.now() });
      this.input.setValue("");
      this.actions.requestRender();
    };
  }

  private get job(): AgentDashboardJob | undefined {
    return this.dashboard.getJob(this.jobId);
  }

  private moveScroll(delta: number): void {
    const job = this.job;
    if (!job) return;
    const max = Math.max(0, transcriptLines(job, this.theme).length - 20);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + delta));
    this.followTail = this.scrollOffset >= max;
    this.actions.requestRender();
  }

  handleInput(data: string): void {
    const job = this.job;
    if (!job) {
      this.done();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.zone = this.zone === "output" ? "input" : this.zone === "input" ? "actions" : "output";
      this.actions.requestRender();
      return;
    }
    if (matchesKey(data, "p")) {
      const control = this.dashboard.control(job.id);
      if (job.status === "paused") control?.resume();
      else if (!isFinishedStatus(job.status)) control?.pause();
      return;
    }
    if (matchesKey(data, "c")) {
      if (!isFinishedStatus(job.status)) this.dashboard.control(job.id)?.cancel();
      return;
    }
    if (matchesKey(data, "shift+c")) {
      this.actions.cancelRun();
      return;
    }
    if (matchesKey(data, "r")) {
      if (job.status === "failed" || job.status === "cancelled" || job.status === "paused") {
        this.dashboard.control(job.id)?.restart();
      }
      return;
    }
    if (matchesKey(data, "f")) {
      this.metadata = !this.metadata;
      this.actions.requestRender();
      return;
    }
    if (matchesKey(data, "y")) {
      this.actions.copy(job);
      return;
    }

    if (this.zone === "input") {
      this.input.handleInput(data);
      this.actions.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (job.tools.length > 0) this.selectedToolIndex = Math.max(0, this.selectedToolIndex - 1);
      this.moveScroll(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (job.tools.length > 0) this.selectedToolIndex = Math.min(job.tools.length - 1, this.selectedToolIndex + 1);
      this.moveScroll(1);
      return;
    }
    if (matchesKey(data, Key.space) && job.tools.length > 0) {
      const tool = job.tools[this.selectedToolIndex];
      this.dashboard.toggleTool(job.id, tool?.id ?? "");
      return;
    }
  }

  render(width: number): string[] {
    const job = this.job;
    if (!job) return [this.theme.fg("error", "Agent no longer exists")];

    const innerWidth = Math.max(10, width - 4);
    const border = this.theme.fg(job.status === "failed" ? "error" : "accent", "│");
    const top = this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`);
    const bottom = this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`);
    const title = `${statusIcon(job, this.theme)} ${job.title} ${this.theme.fg("muted", `[${job.groupTitle}]`)}  ${this.theme.fg("dim", job.status)}`;
    const lines: string[] = [top, `${border}${pad(title, innerWidth)}${border}`];

    if (this.metadata) {
      lines.push(`${border}${pad(this.theme.fg("accent", "Files / tests"), innerWidth)}${border}`);
      const entries = [
        ...job.files.map((file) => `file  ${file}`),
        ...job.tests.map((test) => `test  ${test}`),
      ];
      lines.push(...(entries.length > 0 ? entries : ["(none discovered)"]).map((line) => `${border}${pad(line, innerWidth)}${border}`));
    } else {
      const transcript = transcriptLines(job, this.theme);
      if (this.followTail && transcript.length !== this.lastTranscriptLength) {
        this.scrollOffset = Math.max(0, transcript.length - 20);
      }
      this.lastTranscriptLength = transcript.length;
      const visible = transcript.slice(this.scrollOffset, this.scrollOffset + 20);
      if (this.scrollOffset > 0) lines.push(`${border}${pad(this.theme.fg("dim", "↑ more"), innerWidth)}${border}`);
      lines.push(...visible.map((line) => `${border}${pad(line, innerWidth)}${border}`));
      for (const tool of job.tools.slice(-5)) {
        const index = job.tools.indexOf(tool);
        lines.push(`${border}${pad(toolLine(job, index, this.selectedToolIndex, this.theme), innerWidth)}${border}`);
        if (tool.expanded && tool.output) {
          for (const outputLine of tool.output.split("\n").slice(-6)) {
            lines.push(`${border}${pad(`  ${outputLine}`, innerWidth)}${border}`);
          }
        }
      }
      if (this.scrollOffset + visible.length < transcript.length) lines.push(`${border}${pad(this.theme.fg("dim", "↓ more"), innerWidth)}${border}`);
    }

    const inputEnabled = !isFinishedStatus(job.status) && job.status !== "paused";
    this.input.focused = this.focused && this.zone === "input";
    const inputLines = this.input.render(Math.max(1, innerWidth - 2));
    const inputText = inputEnabled ? inputLines[0] ?? "> " : this.theme.fg("dim", "read-only");
    lines.push(`${border}${pad(`${this.zone === "input" ? "▸" : " "} ${inputText}`, innerWidth)}${border}`);
    lines.push(`${border}${pad(this.theme.fg("dim", "Tab focus · ↑↓ scroll · P pause · C cancel · R retry · F files · Y copy · Esc close"), innerWidth)}${border}`);
    lines.push(bottom);
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.backdrop.hide();
  }
}

class DimBackdrop implements Component {
  constructor(private readonly theme: Theme) {}

  render(width: number): string[] {
    const fill = this.theme.fg("dim", this.theme.bg("customMessageBg", " ".repeat(Math.max(1, width))));
    return new Array(200).fill(fill);
  }

  invalidate(): void {}
}

function statusIcon(job: AgentDashboardJob, theme: Theme): string {
  if (job.status === "completed") return theme.fg("success", "✓");
  if (job.status === "failed") return theme.fg("error", "✗");
  if (job.status === "paused") return theme.fg("warning", "Ⅱ");
  if (job.status === "cancelled") return theme.fg("muted", "∅");
  return theme.fg("accent", "●");
}

function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "...");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}
