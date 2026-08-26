import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowLifecycleEvent,
  decodeWorkflowLifecycleEvent,
  workflowLifecycleMetadata,
  WORKFLOW_LIFECYCLE_EVENT,
  type WorkflowLifecycleEvent,
} from "../workflow-lifecycle.ts";

export type CmuxTaskState = WorkflowLifecycleEvent["state"];
export type CmuxCommandRunner = (args: readonly string[]) => Promise<boolean>;

export interface CmuxEnvironment {
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
}

const STATUS_KEY = "pi_workbench";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

export function cmuxTitle(event: WorkflowLifecycleEvent): string {
  const metadata = workflowLifecycleMetadata(event);
  return `${metadata.title} · ${metadata.status}`;
}

function cmuxNotification(event: WorkflowLifecycleEvent, environment: CmuxEnvironment): readonly string[] | undefined {
  if (!environment.workspaceId || !environment.surfaceId) return undefined;
  const metadata = workflowLifecycleMetadata(event);
  return [
    "notify",
    "--title", metadata.title,
    "--subtitle", metadata.status,
    "--body", metadata.description,
    "--workspace", environment.workspaceId,
    "--surface", environment.surfaceId,
  ];
}

function transitionCommands(
  event: WorkflowLifecycleEvent,
  environment: CmuxEnvironment,
  notify: boolean,
): readonly (readonly string[])[] {
  if (!environment.workspaceId) return [];
  const metadata = workflowLifecycleMetadata(event);
  const commands: Array<readonly string[]> = [];
  if (environment.surfaceId) {
    commands.push([
      "rename-tab",
      "--workspace", environment.workspaceId,
      "--surface", environment.surfaceId,
      "--title", cmuxTitle(event),
    ]);
  }
  commands.push(
    [
      "workspace-action",
      "--workspace", environment.workspaceId,
      "--action", "set-description",
      "--description", metadata.description,
    ],
    [
      "set-status", STATUS_KEY, metadata.status,
      "--icon", metadata.icon,
      "--color", metadata.color,
      "--workspace", environment.workspaceId,
    ],
    [
      "set-progress", metadata.progress.toFixed(2),
      "--label", metadata.progressLabel,
      "--workspace", environment.workspaceId,
    ],
    [
      "log",
      "--level", metadata.level,
      "--source", "pi",
      "--workspace", environment.workspaceId,
      "--", metadata.description,
    ],
  );
  const notification = notify ? cmuxNotification(event, environment) : undefined;
  if (notification) commands.push(notification);
  return commands;
}

function activityCommands(environment: CmuxEnvironment): readonly (readonly string[])[] {
  if (!environment.workspaceId) return [];
  return [["set-progress", "0.55", "--label", "Pi · working", "--workspace", environment.workspaceId]];
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
    const child = spawn(executable, [...args], { env: childEnvironment, stdio: "ignore" });
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

  transition(event: WorkflowLifecycleEvent, notify = false): void {
    this.enqueue(transitionCommands(event, this.environment, notify));
  }

  activity(): void {
    this.enqueue(activityCommands(this.environment));
  }

  clear(): void {
    this.enqueue(cleanupCommands(this.environment));
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

function setTerminalTitle(ctx: ExtensionContext | undefined, event: WorkflowLifecycleEvent): void {
  if (ctx?.hasUI) ctx.ui.setTitle(cmuxTitle(event));
}

export function registerCmuxWorkbench(pi: ExtensionAPI, options: RegisterOptions = {}): CmuxTaskBridge {
  const environment = options.environment ?? process.env;
  const cmuxEnvironment: CmuxEnvironment = {
    workspaceId: text(environment.CMUX_WORKSPACE_ID),
    surfaceId: text(environment.CMUX_SURFACE_ID) ?? text(environment.CMUX_TAB_ID),
  };
  const bridge = new CmuxTaskBridge(cmuxEnvironment, options.runner ?? createCmuxCommandRunner(environment));
  let currentEvent = createWorkflowLifecycleEvent("session", "running");
  const terminalRuns = new Map<string, number>();
  const backgroundTasks = new Map<string, number>();
  const attentionEpisodes = new Map<string, AttentionEpisode>();
  const supervisorRequests = new Map<string, number>();

  pi.on("before_agent_start", (_event, ctx) => {
    currentEvent = createWorkflowLifecycleEvent("session", "running");
    setTerminalTitle(ctx, currentEvent);
    bridge.transition(currentEvent);
  });

  pi.on("tool_execution_start", () => {
    bridge.activity();
  });

  pi.on("agent_end", () => {
    bridge.activity();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) return;
    currentEvent = createWorkflowLifecycleEvent("session", "completed");
    setTerminalTitle(ctx, currentEvent);
    // cmux-session.ts owns ordinary parent completion notifications.
    bridge.transition(currentEvent);
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
      bridge.activity();
      return;
    }
    if (type !== "needs_attention") return;
    pruneAttentionEpisodes(attentionEpisodes, 5 * 60 * 1000);
    const previous = attentionEpisodes.get(childKey);
    if (previous && Date.now() - previous.at <= 5 * 60 * 1000) return;
    const reason = text(payload?.reason);
    attentionEpisodes.set(childKey, { at: Date.now(), source: "control", reason });
    bridge.transition(createWorkflowLifecycleEvent("delegation", "needs_attention"), true);
  });

  pi.events.on("pi-intercom:detach-request", (value: unknown) => {
    const payload = record(value);
    const requestId = text(payload?.requestId);
    const runId = text(payload?.runId);
    if (!requestId || !runId || !rememberBounded(supervisorRequests, requestId, 10 * 60 * 1000)) return;
    const childKey = `${runId}:${integer(payload?.childIndex) ?? ""}`;
    pruneAttentionEpisodes(attentionEpisodes, 5 * 60 * 1000);
    const previous = attentionEpisodes.get(childKey);
    attentionEpisodes.set(childKey, { at: Date.now(), source: "detach" });
    if (previous?.source === "control" && previous.reason === "supervisor_request" && Date.now() - previous.at <= 5_000) return;
    bridge.transition(createWorkflowLifecycleEvent("delegation", "blocked"), true);
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
    bridge.transition(createWorkflowLifecycleEvent("delegation", success ? "completed" : "failed"), !success);
  });

  pi.events.on("pi-background-tasks:terminal:v1", (value: unknown) => {
    const payload = record(value);
    if (text(payload?.schema_version) !== "pi-background-tasks.extension-terminal.v1") return;
    const taskPayload = record(payload?.task);
    const id = text(taskPayload?.id);
    if (!id || !rememberBounded(backgroundTasks, id, 60 * 60 * 1000)) return;
    const success = text(taskPayload?.status) === "completed";
    bridge.transition(createWorkflowLifecycleEvent("background", success ? "completed" : "failed"), !success);
  });

  pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (value: unknown) => {
    const event = decodeWorkflowLifecycleEvent(value);
    if (!event) return;
    currentEvent = event;
    const notify = ["needs_attention", "blocked", "completed", "failed", "cancelled", "interrupted"].includes(event.state);
    bridge.transition(event, notify);
  });

  return bridge;
}

export default function cmuxWorkbenchExtension(pi: ExtensionAPI): void {
  registerCmuxWorkbench(pi);
}
