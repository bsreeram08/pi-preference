import { spawn } from "node:child_process";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { AgentDetailOverlay } from "./agent-overlay.ts";
import { AgentDashboardState, isFinishedStatus, type AgentControl, type AgentDashboardJob, type AgentToolEvent, type AgentTranscriptItem } from "./dashboard-state.ts";
import { createWorkbenchFooter } from "./workbench-footer.ts";

export class WorkbenchDashboardController {
  readonly state = new AgentDashboardState();
  private ctx?: ExtensionContext;
  private unsubscribeInput?: () => void;
  private overlayOpen = false;
  private overlayPromise?: Promise<void>;
  private footerTimer?: ReturnType<typeof setTimeout>;
  private runController?: AbortController;

  constructor(private readonly pi: ExtensionAPI) {}

  attach(ctx: ExtensionContext): void {
    this.disposeInput();
    this.ctx = ctx;
    if (ctx.mode !== "tui") return;
    this.footerTimer = setTimeout(() => {
      if (this.ctx !== ctx) return;
      ctx.ui.setFooter(createWorkbenchFooter(ctx, this.state));
    }, 0);
    this.unsubscribeInput = ctx.ui.onTerminalInput((data) => this.handleInput(data));
  }

  beginRun(runId: string, runController?: AbortController): void {
    this.state.beginRun(runId);
    this.runController = runController;
  }

  focusCards(): void {
    this.state.setFocused(true);
  }

  unfocusCards(): void {
    this.state.setFocused(false);
  }

  endRun(): void {
    this.runController = undefined;
    this.state.endRun();
  }

  cancelRun(): void {
    this.runController?.abort();
    for (const job of this.state.getActiveGroups().flatMap((group) => group.jobs)) {
      this.state.control(job.id)?.cancel();
    }
  }

  ensureGroup(id: string, title: string): void {
    this.state.ensureGroup(id, title);
  }

  addJob(id: string, title: string, groupId: string, groupTitle: string): void {
    this.state.addJob({ id, title, groupId, groupTitle });
  }

  setControl(id: string, control: AgentControl | undefined): void {
    this.state.setControl(id, control);
  }

  updateJob(id: string, patch: Parameters<AgentDashboardState["updateJob"]>[1]): void {
    this.state.updateJob(id, patch);
  }

  finishJob(id: string, status: "completed" | "failed" | "cancelled", patch: Parameters<AgentDashboardState["finishJob"]>[2] = {}): void {
    this.state.finishJob(id, status, patch);
  }

  addTranscript(id: string, item: AgentTranscriptItem): void {
    this.state.addTranscript(id, item);
  }

  addTool(id: string, tool: AgentToolEvent): void {
    this.state.addTool(id, tool);
  }

  dispose(): void {
    this.disposeInput();
    if (this.footerTimer) clearTimeout(this.footerTimer);
    this.footerTimer = undefined;
    this.overlayOpen = false;
    this.cancelRun();
    this.runController = undefined;
    this.ctx?.ui.setFooter(undefined);
    this.ctx = undefined;
    this.state.clear();
  }

  private disposeInput(): void {
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
  }

  private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.overlayOpen) return undefined;

    if (matchesKey(data, "ctrl+alt+down")) {
      this.state.setFocused(true);
      return { consume: true };
    }
    if (!this.state.isFocused()) return undefined;

    if (matchesKey(data, Key.escape)) {
      this.state.setFocused(false);
      return { consume: true };
    }
    if (matchesKey(data, Key.left)) {
      this.state.selectNext(-1);
      return { consume: true };
    }
    if (matchesKey(data, Key.right)) {
      this.state.selectNext(1);
      return { consume: true };
    }
    if (matchesKey(data, Key.up)) {
      this.state.selectGroup(-1);
      return { consume: true };
    }
    if (matchesKey(data, Key.down)) {
      this.state.selectGroup(1);
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.state.getSelectedJob();
      if (selected && isFinishedStatus(selected.status) && !this.state.isFinishedExpanded()) this.state.toggleFinished();
      else if (selected) void this.openOverlay(selected.id);
      else if (this.state.finishedCount > 0) this.state.toggleFinished();
      return { consume: true };
    }
    if (matchesKey(data, Key.space)) {
      const selected = this.state.getSelectedJob();
      if (selected) this.state.toggleGroup(selected.groupId);
      return { consume: true };
    }

    const selected = this.state.getSelectedJob();
    if (matchesKey(data, "p")) {
      if (selected && !isFinishedStatus(selected.status)) {
        if (selected.status === "paused") this.state.control(selected.id)?.resume();
        else this.state.control(selected.id)?.pause();
      }
      return { consume: true };
    }
    if (matchesKey(data, "c")) {
      if (selected && !isFinishedStatus(selected.status)) this.state.control(selected.id)?.cancel();
      return { consume: true };
    }
    if (matchesKey(data, "shift+c")) {
      this.cancelRun();
      return { consume: true };
    }
    if (matchesKey(data, "r")) {
      if (selected && (selected.status === "failed" || selected.status === "cancelled" || selected.status === "paused")) {
        this.state.control(selected.id)?.restart();
      }
      return { consume: true };
    }

    return undefined;
  }

  private async openOverlay(jobId: string): Promise<void> {
    if (this.overlayOpen || !this.ctx || this.ctx.mode !== "tui") return;
    this.overlayOpen = true;
    this.state.setFocused(false);
    const ctx = this.ctx;
    this.overlayPromise = ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new AgentDetailOverlay(tui, theme, this.state, jobId, {
          cancelRun: () => this.cancelRun(),
          copy: (job) => void this.copyJob(job),
          requestRender: () => tui.requestRender(),
        }, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "96%",
          maxHeight: "92%",
          margin: 1,
        },
      },
    );
    await this.overlayPromise;
    this.overlayPromise = undefined;
    this.overlayOpen = false;
  }

  private async copyJob(job: AgentDashboardJob): Promise<void> {
    const text = job.output ?? job.transcript.map((item) => item.text).join("\n\n");
    if (!text) return;
    const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
    try {
      const child = spawn(command, process.platform === "linux" ? ["-selection", "clipboard"] : [], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(text);
      child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });
      this.ctx?.ui.notify(`Copied ${job.title} output`, "info");
    } catch {
      this.ctx?.ui.notify("Clipboard is unavailable in this terminal", "warning");
    }
  }
}
