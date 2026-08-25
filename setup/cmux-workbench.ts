import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CmuxTaskState = "running" | "needs_attention" | "blocked" | "completed" | "failed";

export interface CmuxTaskUpdate {
  task: string;
  state: CmuxTaskState;
  detail?: string;
  progress?: { value: number; label: string };
  notify?: boolean;
}

export type CmuxCommandRunner = (args: readonly string[]) => Promise<boolean>;

interface CmuxEnvironment {
  readonly workspaceId?: string;
  readonly surfaceId?: string;
}

interface RegisterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: CmuxCommandRunner;
}

interface CmuxRunnerOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

interface AttentionEpisode {
  readonly at: number;
  readonly source: "control" | "detach";
  readonly reason?: string;
  readonly requestId?: string;
}

const STATUS_KEY = "pi_workbench";
const TITLE_TASK_LIMIT = 48;
const DETAIL_LIMIT = 160;

const STATE_STYLE: Record<CmuxTaskState, { label: string; icon: string; color: string; level: string; progress: number }> = {
  running: { label: "working", icon: "sparkle", color: "#FF8A4C", level: "progress", progress: 0.15 },
  needs_attention: { label: "needs attention", icon: "exclamationmark.triangle", color: "#E7B84B", level: "warning", progress: 0.85 },
  blocked: { label: "blocked", icon: "exclamationmark.octagon", color: "#E85D5D", level: "error", progress: 0.85 },
  completed: { label: "done", icon: "checkmark.circle", color: "#4CAF7A", level: "success", progress: 1 },
  failed: { label: "failed", icon: "xmark.circle", color: "#E85D5D", level: "error", progress: 1 },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function rememberBounded(map: Map<string, number>, key: string, ttlMs: number, maximum = 200): boolean {
  const now = Date.now();
  const previous = map.get(key);
  if (previous !== undefined && now - previous <= ttlMs) return false;
  map.set(key, now);
  if (map.size > maximum) {
    for (const [storedKey, storedAt] of map) {
      if (now - storedAt > ttlMs || map.size > maximum) map.delete(storedKey);
    }
  }
  return true;
}

function pruneAttentionEpisodes(map: Map<string, AttentionEpisode>, ttlMs: number, maximum = 200): void {
  const now = Date.now();
  if (map.size <= maximum && [...map.values()].every((episode) => now - episode.at <= ttlMs)) return;
  for (const [key, episode] of map) {
    if (now - episode.at > ttlMs || map.size > maximum) map.delete(key);
  }
}

export function sanitizeCmuxText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function taskTitle(value: unknown): string {
  return sanitizeCmuxText(value, TITLE_TASK_LIMIT) || "Pi task";
}

export function cmuxTitle(task: string, state: CmuxTaskState): string {
  return `${taskTitle(task)} · ${STATE_STYLE[state].label}`;
}

function cmuxDescription(update: CmuxTaskUpdate): string {
  const detail = sanitizeCmuxText(update.detail, DETAIL_LIMIT);
  const prefix = `Pi ${STATE_STYLE[update.state].label}: ${taskTitle(update.task)}`;
  return detail ? `${prefix} — ${detail}` : prefix;
}

function cmuxNotification(update: CmuxTaskUpdate, environment: CmuxEnvironment): readonly string[] | undefined {
  if (!update.notify || !environment.surfaceId) return undefined;
  const style = STATE_STYLE[update.state];
  return [
    "notify",
    "--title", `Pi ${style.label}`,
    "--subtitle", taskTitle(update.task),
    "--body", sanitizeCmuxText(update.detail, DETAIL_LIMIT) || style.label,
    "--workspace", environment.workspaceId!,
    "--surface", environment.surfaceId,
  ];
}

function transitionCommands(update: CmuxTaskUpdate, environment: CmuxEnvironment): readonly (readonly string[])[] {
  if (!environment.workspaceId) return [];
  const style = STATE_STYLE[update.state];
  const progress = update.progress ?? { value: style.progress, label: `Pi · ${style.label}` };
  const value = Math.min(1, Math.max(0, Number.isFinite(progress.value) ? progress.value : style.progress));
  const commands: Array<readonly string[]> = [];
  if (environment.surfaceId) {
    commands.push([
      "rename-tab",
      "--workspace", environment.workspaceId,
      "--surface", environment.surfaceId,
      "--title", cmuxTitle(update.task, update.state),
    ]);
  }
  commands.push(
    [
      "workspace-action",
      "--workspace", environment.workspaceId,
      "--action", "set-description",
      "--description", cmuxDescription(update),
    ],
    [
      "set-status", STATUS_KEY, style.label,
      "--icon", style.icon,
      "--color", style.color,
      "--workspace", environment.workspaceId,
    ],
    [
      "set-progress", value.toFixed(2),
      "--label", sanitizeCmuxText(progress.label, 64) || `Pi · ${style.label}`,
      "--workspace", environment.workspaceId,
    ],
    [
      "log",
      "--level", style.level,
      "--source", "pi",
      "--workspace", environment.workspaceId,
      "--", sanitizeCmuxText(update.detail, DETAIL_LIMIT) || cmuxDescription(update),
    ],
  );
  const notification = cmuxNotification(update, environment);
  if (notification) commands.push(notification);
  return commands;
}

function activityCommands(label: string, environment: CmuxEnvironment): readonly (readonly string[])[] {
  if (!environment.workspaceId) return [];
  return [[
    "set-progress", "0.55",
    "--label", sanitizeCmuxText(label, 64) || "Pi · working",
    "--workspace", environment.workspaceId,
  ]];
}

function cleanupCommands(environment: CmuxEnvironment): readonly (readonly string[])[] {
  if (!environment.workspaceId) return [];
  return [
    ["clear-progress", "--workspace", environment.workspaceId],
    ["clear-status", STATUS_KEY, "--workspace", environment.workspaceId],
  ];
}

function safeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL",
    "CMUX_SOCKET_PATH", "CMUX_SOCKET", "CMUX_SOCKET_PASSWORD",
    "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID",
  ];
  return Object.fromEntries(allowed.flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
}

function cmuxExecutable(environment: NodeJS.ProcessEnv): string {
  const explicit = text(environment.CMUX_BUNDLED_CLI_PATH);
  if (explicit) return explicit;
  const agentDir = text(environment.PI_CODING_AGENT_DIR) ?? path.join(text(environment.HOME) ?? os.homedir(), ".pi", "agent");
  return path.join(agentDir, "bin", "cmux");
}

export function createCmuxCommandRunner(
  environment: NodeJS.ProcessEnv = process.env,
  options: CmuxRunnerOptions = {},
): CmuxCommandRunner {
  const executable = cmuxExecutable(environment);
  const childEnvironment = safeEnvironment(environment);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
  const killGraceMs = Math.max(1, options.killGraceMs ?? 500);
  return (args) => new Promise<boolean>((resolve) => {
    let finished = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, [...args], {
      env: childEnvironment,
      stdio: "ignore",
    });
    child.unref();
    const finish = (success: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(success);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(!timedOut && code === 0));
  });
}

export class CmuxTaskBridge {
  readonly environment: CmuxEnvironment;
  readonly runner: CmuxCommandRunner;
  private tail: Promise<void> = Promise.resolve();

  constructor(environment: CmuxEnvironment, runner: CmuxCommandRunner) {
    this.environment = environment;
    this.runner = runner;
  }

  private enqueue(commands: readonly (readonly string[])[]): void {
    if (commands.length === 0) return;
    this.tail = this.tail
      .then(async () => {
        await Promise.all(commands.map(async (args) => { await this.runner(args); }));
      })
      .catch(() => undefined);
  }

  transition(update: CmuxTaskUpdate): void {
    this.enqueue(transitionCommands({ ...update, task: taskTitle(update.task) }, this.environment));
  }

  activity(label: string): void {
    this.enqueue(activityCommands(label, this.environment));
  }

  clear(): void {
    this.enqueue(cleanupCommands(this.environment));
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

function eventTask(payload: Record<string, unknown> | undefined, fallback: string): string {
  return taskTitle(text(payload?.label) ?? text(payload?.summary) ?? text(payload?.name) ?? fallback);
}

function setTerminalTitle(ctx: ExtensionContext | undefined, task: string, state: CmuxTaskState): void {
  if (ctx?.hasUI) ctx.ui.setTitle(cmuxTitle(task, state));
}

export function registerCmuxWorkbench(pi: ExtensionAPI, options: RegisterOptions = {}): CmuxTaskBridge {
  const environment = options.environment ?? process.env;
  const cmuxEnvironment: CmuxEnvironment = {
    workspaceId: text(environment.CMUX_WORKSPACE_ID),
    surfaceId: text(environment.CMUX_SURFACE_ID) ?? text(environment.CMUX_TAB_ID),
  };
  const bridge = new CmuxTaskBridge(cmuxEnvironment, options.runner ?? createCmuxCommandRunner(environment));
  let currentTask = "Pi task";
  const terminalRuns = new Map<string, number>();
  const backgroundTasks = new Map<string, number>();
  const attentionEpisodes = new Map<string, AttentionEpisode>();
  const supervisorRequests = new Map<string, number>();

  pi.on("before_agent_start", (event, ctx) => {
    currentTask = taskTitle(event.prompt);
    setTerminalTitle(ctx, currentTask, "running");
    bridge.transition({ task: currentTask, state: "running", detail: "Pi started working" });
  });

  pi.on("tool_execution_start", (event) => {
    bridge.activity(`Pi · ${sanitizeCmuxText(event.toolName, 40) || "working"}`);
  });

  pi.on("agent_end", () => {
    bridge.activity("Pi · finishing");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) return;
    setTerminalTitle(ctx, currentTask, "completed");
    // cmux-session.ts owns the parent completion notification; this companion only
    // updates cmux metadata so the user receives one completion notification.
    bridge.transition({ task: currentTask, state: "completed", detail: "Pi is ready for input" });
  });

  pi.on("session_shutdown", () => {
    bridge.clear();
  });

  pi.events.on("subagent:control-event", (value: unknown) => {
    const envelope = record(value);
    const payload = record(envelope?.event);
    const type = text(payload?.type);
    const runId = text(payload?.runId);
    if (!runId) return;
    const childKey = `${runId}:${integer(payload?.index) ?? ""}`;
    if (type === "active_long_running") {
      attentionEpisodes.delete(childKey);
      bridge.activity("Pi · long-running work");
      return;
    }
    if (type !== "needs_attention") return;
    pruneAttentionEpisodes(attentionEpisodes, 5 * 60 * 1000);
    const previous = attentionEpisodes.get(childKey);
    if (previous && Date.now() - previous.at <= 5 * 60 * 1000) return;
    const controlReason = text(payload?.reason);
    attentionEpisodes.set(childKey, { at: Date.now(), source: "control", reason: controlReason });
    const reason = text(payload?.message) ?? text(payload?.recentFailureSummary) ?? text(envelope?.noticeText) ?? "A delegated workflow needs attention";
    const task = eventTask(payload, currentTask);
    bridge.transition({ task, state: "needs_attention", detail: reason, notify: true });
  });

  pi.events.on("pi-intercom:detach-request", (value: unknown) => {
    const payload = record(value);
    const requestId = text(payload?.requestId);
    const runId = text(payload?.runId);
    if (!requestId || !runId || !rememberBounded(supervisorRequests, requestId, 10 * 60 * 1000)) return;
    const childKey = `${runId}:${integer(payload?.childIndex) ?? ""}`;
    pruneAttentionEpisodes(attentionEpisodes, 5 * 60 * 1000);
    const previous = attentionEpisodes.get(childKey);
    attentionEpisodes.set(childKey, { at: Date.now(), source: "detach", requestId });
    // A control event and detach request are two views of one supervisor ask.
    // Distinct request IDs from the same child remain independently actionable.
    if (previous?.source === "control" && previous.reason === "supervisor_request" && Date.now() - previous.at <= 5_000) return;
    bridge.transition({
      task: eventTask(payload, currentTask),
      state: "blocked",
      detail: "A delegated workflow is waiting for a supervisor response",
      notify: true,
    });
  });

  pi.events.on("subagent:async-complete", (value: unknown) => {
    const payload = record(value);
    if (text(payload?.source) !== "async") return;
    const runId = text(payload?.runId) ?? text(payload?.id);
    if (!runId || !rememberBounded(terminalRuns, runId, 60 * 60 * 1000)) return;
    for (const key of attentionEpisodes.keys()) {
      if (key.startsWith(`${runId}:`)) attentionEpisodes.delete(key);
    }
    const success = payload?.success === true || ["complete", "completed"].includes(text(payload?.state) ?? "");
    const task = eventTask(payload, currentTask);
    bridge.transition({
      task,
      state: success ? "completed" : "failed",
      detail: text(payload?.summary) ?? (success ? "Asynchronous workflow completed" : "Asynchronous workflow did not complete successfully"),
      // Successful async work produces one parent follow-up notification. Failures
      // are actionable and notify immediately.
      notify: !success,
    });
  });

  pi.events.on("pi-background-tasks:terminal:v1", (value: unknown) => {
    const payload = record(value);
    if (text(payload?.schema_version) !== "pi-background-tasks.extension-terminal.v1") return;
    const taskPayload = record(payload?.task);
    const id = text(taskPayload?.id);
    if (!id || !rememberBounded(backgroundTasks, id, 60 * 60 * 1000)) return;
    const status = text(taskPayload?.status) ?? "failed";
    const success = status === "completed";
    bridge.transition({
      task: eventTask(taskPayload, currentTask),
      state: success ? "completed" : "failed",
      detail: text(taskPayload?.error) ?? `Background task ${status}`,
      notify: !success,
    });
  });

  pi.events.on("pi-workbench:task-state:v1", (value: unknown) => {
    const payload = record(value);
    if (payload?.schemaVersion !== 1) return;
    const state = text(payload?.state) as CmuxTaskState | undefined;
    if (!state || !(state in STATE_STYLE)) return;
    const task = taskTitle(text(payload?.title) ?? currentTask);
    currentTask = task;
    const progressPayload = record(payload?.progress);
    const progressValue = typeof progressPayload?.value === "number" ? progressPayload.value : undefined;
    const progressLabel = text(progressPayload?.label);
    bridge.transition({
      task,
      state,
      detail: text(payload?.detail),
      progress: progressValue === undefined ? undefined : { value: progressValue, label: progressLabel ?? `Pi · ${STATE_STYLE[state].label}` },
      notify: state === "blocked" || state === "needs_attention" || state === "failed" || (state === "completed" && payload?.terminal === true),
    });
  });

  return bridge;
}

export default function cmuxWorkbenchExtension(pi: ExtensionAPI): void {
  registerCmuxWorkbench(pi);
}
