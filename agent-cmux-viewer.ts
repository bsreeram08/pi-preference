import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRunStatus } from "./agent-run-store.ts";
import { createCmuxOutputRunner, type CmuxOutputRunner } from "./cmux-workbench.ts";

const MAX_VIEW_OUTPUT_BYTES = 64 * 1024;

export interface AgentViewerStart {
  readonly runId: string;
  readonly agentId: string;
  readonly viewerFile: string;
  readonly projectName: string;
  readonly status: AgentRunStatus;
  readonly model?: string;
}

export interface AgentViewerUpdate {
  readonly runId: string;
  readonly status?: AgentRunStatus;
  readonly output?: string;
  readonly question?: string;
  readonly turns?: number;
  readonly tools?: number;
  readonly errorCode?: string;
}

export interface AgentRunViewer {
  start(input: AgentViewerStart): void;
  update(input: AgentViewerUpdate): void;
  focus(runId: string): void;
}

interface CmuxIdentity {
  readonly workspace: string;
  readonly pane: string;
}

interface ViewState {
  readonly runId: string;
  readonly title: string;
  readonly viewerFile: string;
  readonly projectName: string;
  readonly model?: string;
  status: AgentRunStatus;
  surface?: string;
  workspace?: string;
  pane?: string;
  output: string;
  question?: string;
  turns: number;
  tools: number;
  errorCode?: string;
  titleState?: string;
  writeTimer?: NodeJS.Timeout;
  writeTail: Promise<void>;
}

function bounded(value: string, maximum = MAX_VIEW_OUTPUT_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let result = value.slice(-maximum);
  while (Buffer.byteLength(result, "utf8") > maximum) result = result.slice(1);
  return `[Earlier output omitted]\n${result}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function lifecycleLabel(status: AgentRunStatus): string {
  switch (status) {
    case "queued": return "queued";
    case "starting": return "starting";
    case "running": return "working";
    case "steering": return "steering";
    case "waiting_for_parent": return "waiting";
    case "cancelling": return "cancelling";
    case "terminating": return "stopping";
    case "completed": return "done";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    case "orphaned": return "orphaned";
  }
}

const CATEGORICAL_AGENT_TITLES: Readonly<Record<string, string>> = {
  "codebase-explorer": "Codebase Explorer",
  researcher: "Researcher",
  "technical-reviewer": "Technical Reviewer",
  "requirements-analyst": "Requirements Analyst",
  planner: "Planner",
  "quality-reviewer": "Quality Reviewer",
  "execution-manager": "Execution Manager",
  implementer: "Implementer",
  "task-implementer": "Task Implementer",
  "council-supervisor": "Council Supervisor",
  product: "Product Advisor",
  opponent: "Opponent",
  architect: "Architect",
  developer: "Developer",
  ux: "UX Advisor",
  security: "Security Reviewer",
  qa: "QA Reviewer",
  hiring: "Hiring Advisor",
};

export function categoricalAgentTitle(agentId: string): string {
  if (!Object.prototype.hasOwnProperty.call(CATEGORICAL_AGENT_TITLES, agentId)) return "Specialist";
  return CATEGORICAL_AGENT_TITLES[agentId] ?? "Specialist";
}

function tabTitle(state: ViewState): string {
  return `${state.title} · ${lifecycleLabel(state.status)}`;
}

function renderHtml(state: ViewState): string {
  const status = lifecycleLabel(state.status);
  const statusClass = ["failed", "cancelled", "interrupted", "orphaned"].includes(status)
    ? "bad"
    : status === "done" ? "good" : status === "waiting" ? "warn" : "active";
  const output = state.output || (state.status === "starting" || state.status === "queued" ? "Waiting for the agent to start…" : "No assistant output yet.");
  const question = state.question ? `<section class="question"><strong>Parent input required</strong><p>${escapeHtml(state.question)}</p><p class="hint">Answer from the Pi agent dashboard.</p></section>` : "";
  const error = state.errorCode ? `<span class="error">${escapeHtml(state.errorCode)}</span>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(tabTitle(state))}</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#e9e9e9}*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1100px}header{border-bottom:1px solid #343434;padding-bottom:16px;margin-bottom:18px}h1{font-size:20px;margin:0 0 10px;color:#ff8a4c}.meta{display:flex;gap:10px;flex-wrap:wrap;color:#aaa;font-size:12px}.pill{border:1px solid #444;border-radius:999px;padding:3px 8px}.active{color:#ff8a4c}.good{color:#55cf88}.warn{color:#f0c75e}.bad,.error{color:#ff6b6b}.question{border:1px solid #f0c75e;background:#211d11;padding:14px;margin:0 0 18px}.question p{margin:8px 0 0}.hint{color:#aaa;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;background:#161616;border:1px solid #2d2d2d;padding:16px;margin:0}.footer{margin-top:14px;color:#777;font-size:11px}
</style></head><body><header><h1>${escapeHtml(state.title)}</h1><div class="meta"><span class="pill ${statusClass}">${escapeHtml(status)}</span><span class="pill">${escapeHtml(state.projectName)}</span>${state.model ? `<span class="pill">${escapeHtml(state.model)}</span>` : ""}<span class="pill">turns ${state.turns}</span><span class="pill">tools ${state.tools}</span>${error}</div></header>${question}<pre>${escapeHtml(bounded(output))}</pre><div class="footer">Read-only cmux view · AgentRunManager remains process and RPC authority · refreshes every second</div></body></html>\n`;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseIdentity(stdout: string): CmuxIdentity | undefined {
  try {
    const value = JSON.parse(stdout) as { caller?: { workspace_ref?: unknown; pane_ref?: unknown } };
    const workspace = value.caller?.workspace_ref;
    const pane = value.caller?.pane_ref;
    return typeof workspace === "string" && /^workspace:\d+$/.test(workspace)
      && typeof pane === "string" && /^pane:\d+$/.test(pane)
      ? { workspace, pane }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCreatedSurface(stdout: string): { surface: string; workspace: string; pane: string } | undefined {
  const match = stdout.trim().match(/^OK\s+(surface:\d+)\s+(pane:\d+)\s+(workspace:\d+)$/);
  return match ? { surface: match[1], pane: match[2], workspace: match[3] } : undefined;
}

export class CmuxAgentTabViewer implements AgentRunViewer {
  private readonly states = new Map<string, ViewState>();
  private commandTail: Promise<void> = Promise.resolve();

  constructor(private readonly runner: CmuxOutputRunner) {}

  start(input: AgentViewerStart): void {
    const state: ViewState = {
      runId: input.runId,
      title: categoricalAgentTitle(input.agentId),
      viewerFile: input.viewerFile,
      projectName: input.projectName,
      status: input.status,
      ...(input.model ? { model: input.model } : {}),
      output: "",
      turns: 0,
      tools: 0,
      writeTail: Promise.resolve(),
    };
    this.states.set(input.runId, state);
    this.scheduleWrite(state, true);
    this.enqueue(async () => {
      await state.writeTail;
      const identityResult = await this.runner(["identify"]);
      const identity = identityResult.ok ? parseIdentity(identityResult.stdout) : undefined;
      if (!identity || this.states.get(input.runId) !== state) return;
      const createdResult = await this.runner([
        "new-surface", "--type", "browser", "--pane", identity.pane, "--workspace", identity.workspace,
        "--url", pathToFileURL(input.viewerFile).href, "--focus", "false",
      ]);
      const created = createdResult.ok ? parseCreatedSurface(createdResult.stdout) : undefined;
      if (!created || created.workspace !== identity.workspace || created.pane !== identity.pane) return;
      state.surface = created.surface;
      state.workspace = created.workspace;
      state.pane = created.pane;
      await this.rename(state);
    });
  }

  update(input: AgentViewerUpdate): void {
    const state = this.states.get(input.runId);
    if (!state) return;
    const previousTitle = tabTitle(state);
    if (input.status) state.status = input.status;
    if (input.output !== undefined) state.output = bounded(input.output);
    if (input.question !== undefined) state.question = input.question || undefined;
    if (input.turns !== undefined) state.turns = input.turns;
    if (input.tools !== undefined) state.tools = input.tools;
    if (input.errorCode !== undefined) state.errorCode = input.errorCode || undefined;
    this.scheduleWrite(state);
    if (tabTitle(state) !== previousTitle && state.surface) this.enqueue(() => this.rename(state));
  }

  focus(runId: string): void {
    const state = this.states.get(runId);
    if (!state?.surface || !state.workspace || !state.pane) return;
    this.enqueue(async () => {
      await this.runner([
        "move-surface", "--surface", state.surface!, "--pane", state.pane!,
        "--workspace", state.workspace!, "--focus", "true",
      ]);
    });
  }

  private scheduleWrite(state: ViewState, immediate = false): void {
    if (state.writeTimer) clearTimeout(state.writeTimer);
    const write = () => {
      state.writeTimer = undefined;
      const html = renderHtml(state);
      state.writeTail = state.writeTail.then(() => atomicWrite(state.viewerFile, html)).catch(() => undefined);
    };
    if (immediate) write();
    else {
      state.writeTimer = setTimeout(write, 100);
      state.writeTimer.unref();
    }
  }

  private async rename(state: ViewState): Promise<void> {
    if (!state.surface || !state.workspace) return;
    const title = tabTitle(state);
    if (state.titleState === title) return;
    const result = await this.runner(["rename-tab", "--workspace", state.workspace, "--surface", state.surface, "--title", title]);
    if (result.ok) state.titleState = title;
  }

  private enqueue(operation: () => Promise<void>): void {
    this.commandTail = this.commandTail.then(operation).catch(() => undefined);
  }
}

export function createCmuxAgentTabViewer(environment: NodeJS.ProcessEnv = process.env): AgentRunViewer | undefined {
  if (!environment.CMUX_WORKSPACE_ID || !(environment.CMUX_SURFACE_ID || environment.CMUX_TAB_ID)) return undefined;
  return new CmuxAgentTabViewer(createCmuxOutputRunner(environment));
}
