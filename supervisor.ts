import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentControl } from "./dashboard-state.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";

const CHILD_TOOLS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-tools.ts");
const MAX_OUTPUT_BYTES = 50 * 1024;
const ACTIONS = new Set(["delegate", "ask_user", "synthesize", "review", "verify", "fix", "complete"]);

export interface SupervisorDecision {
  action: "delegate" | "ask_user" | "synthesize" | "review" | "verify" | "fix" | "complete";
  phase: string;
  roles: string[];
  rationale: string;
  question?: string;
  workerCount?: number;
}

export function canDelegateSpecialists(decision: SupervisorDecision): boolean {
  return decision.roles.length > 0 && !["ask_user", "synthesize", "complete"].includes(decision.action);
}

export function parseSupervisorDecision(output: string): SupervisorDecision | undefined {
  const match = output.match(/<workbench-decision>\s*([\s\S]*?)\s*<\/workbench-decision>/i);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as Partial<SupervisorDecision>;
    if (typeof value.action !== "string" || !ACTIONS.has(value.action)) return undefined;
    if (typeof value.phase !== "string" || !value.phase.trim()) return undefined;
    if (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== "string")) return undefined;
    if (typeof value.rationale !== "string" || !value.rationale.trim()) return undefined;
    return {
      action: value.action as SupervisorDecision["action"],
      phase: value.phase,
      roles: value.roles,
      rationale: value.rationale,
      ...(typeof value.question === "string" ? { question: value.question } : {}),
      ...(typeof value.workerCount === "number" ? { workerCount: Math.max(1, Math.min(4, Math.floor(value.workerCount))) } : {}),
    };
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let result = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) result = result.slice(0, -1);
  return `${result}\n\n[Supervisor output truncated at 50KB.]`;
}

function invocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const virtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !virtual && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

function send(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
  if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
}

function signalGroup(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

export const SUPERVISOR_SYSTEM_PROMPT = `You are the Council Supervisor, the adaptive orchestrator for a project-scoped coding council.

You do not modify files and you do not run implementation workers directly. Decide what the parent Pi Workbench runtime should delegate next. Inspect the project and use supplied reports as evidence. Re-plan after each result. Choose only relevant specialists; do not include UX unless the intent or changed files have a user-facing interface impact. Pi's installed skills are available through progressive disclosure: for nontrivial decisions, read only the matching SKILL.md files and apply their discipline rather than mechanically invoking every skill. Never claim implementation is verified: an independent verifier and explicit user approval are mandatory.

Return exactly one machine-readable decision and no other fenced JSON:
<workbench-decision>{"action":"delegate|ask_user|synthesize|review|verify|fix|complete","phase":"...","roles":["agent-id"],"rationale":"...","question":"optional","workerCount":2}</workbench-decision>

Use action=delegate for specialist work, review for reviewers, verify for verification, fix for corrective implementation, ask_user when a user decision is required, synthesize when the lead should produce an intent, and complete only when all safety gates are already satisfied. Keep roles relevant and concise.`;

export class SupervisorClient {
  private child?: ChildProcessWithoutNullStreams;
  private tempDir?: string;
  private currentOutput = "";
  private pending?: { resolve: (text: string) => void; reject: (error: Error) => void };
  private disposed = false;
  private started = false;

  constructor(
    private readonly projectRoot: string,
    private readonly dashboard: WorkbenchDashboardController,
    private readonly pi: ExtensionAPI,
  ) {
    this.dashboard.addJob("supervisor", "Council Supervisor", "supervisor", "Supervisor");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-workbench-supervisor-"));
    const promptPath = path.join(this.tempDir, "system.md");
    await fsp.writeFile(promptPath, SUPERVISOR_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 });
    const args = [
      "--mode", "rpc", "--no-session", "--no-extensions", "--extension", CHILD_TOOLS_PATH,
      "--no-prompt-templates", "--append-system-prompt", promptPath,
      "--tools", "read,grep,find,ls,qmd_search",
    ];
    const child = spawn(invocation(args).command, invocation(args).args, {
      cwd: this.projectRoot,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_WORKBENCH_AGENT: "supervisor" },
    });
    this.child = child;
    this.dashboard.setControl("supervisor", this.control());
    this.dashboard.updateJob("supervisor", { status: "running", startedAt: Date.now(), latestActivity: "Supervisor started" });

    let buffer = "";
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta") this.currentOutput += delta.delta ?? "";
        this.dashboard.updateJob("supervisor", { output: truncate(this.currentOutput), latestActivity: "Deciding next phase" });
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = Array.isArray(event.message.content)
          ? event.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
          : "";
        if (text) {
          this.currentOutput = text;
          this.dashboard.state.addTranscript("supervisor", { kind: "assistant", text, timestamp: Date.now() });
        }
        this.dashboard.updateJob("supervisor", { output: truncate(this.currentOutput), latestActivity: "Decision ready" });
      } else if (event.type === "tool_execution_start") {
        this.dashboard.updateJob("supervisor", { latestActivity: `${event.toolName ?? "tool"} running` });
      } else if (event.type === "agent_settled") {
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve(this.currentOutput);
      } else if (event.type === "extension_error") {
        const error = String(event.error ?? "Supervisor extension error");
        this.dashboard.updateJob("supervisor", { status: "failed", error, latestActivity: error });
        this.pending?.reject(new Error(error));
        this.pending = undefined;
      }
    };
    child.stdout.on("data", (data: Buffer) => {
      buffer += decoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code) => {
      buffer += decoder.end();
      if (buffer.trim()) processLine(buffer);
      if (!this.disposed && code !== 0) this.fail(new Error(stderr || `Supervisor exited with code ${code}`));
    });
  }

  async decide(context: string): Promise<SupervisorDecision> {
    if (!this.child) await this.start();
    this.currentOutput = "";
    const output = await new Promise<string>((resolve, reject) => {
      if (!this.child) return reject(new Error("Supervisor is not running"));
      this.pending = { resolve, reject };
      send(this.child, { type: "prompt", id: `decision-${Date.now()}`, message: context });
    });
    const decision = parseSupervisorDecision(output);
    if (!decision) throw new Error(`Supervisor returned an invalid decision: ${output.slice(0, 500)}`);
    this.dashboard.updateJob("supervisor", { latestActivity: `${decision.action}: ${decision.phase}`, output: truncate(output) });
    return decision;
  }

  private control(): AgentControl {
    return {
      steer: (message) => {
        if (!this.child) return;
        send(this.child, { type: "steer", message });
        this.dashboard.updateJob("supervisor", { status: "steering", latestActivity: "Supervisor steering queued", queuedMessages: [...(this.dashboard.state.getJob("supervisor")?.queuedMessages ?? []), message] });
      },
      pause: () => {
        signalGroup(this.child, "SIGSTOP");
        this.dashboard.updateJob("supervisor", { status: "paused", latestActivity: "Supervisor suspended" });
      },
      resume: () => {
        signalGroup(this.child, "SIGCONT");
        this.dashboard.updateJob("supervisor", { status: "running", latestActivity: "Supervisor resumed" });
      },
      cancel: () => {
        if (this.child) send(this.child, { type: "abort" });
        this.dashboard.updateJob("supervisor", { status: "cancelled", latestActivity: "Supervisor cancelled" });
      },
      restart: () => {
        // A restart is intentionally handled by the parent run lifecycle.
      },
    };
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.dashboard.finishJob("supervisor", "failed", { error: error.message, latestActivity: "Supervisor failed" });
    this.pending?.reject(error);
    this.pending = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending?.reject(new Error("Supervisor stopped"));
    this.pending = undefined;
    if (this.child) {
      signalGroup(this.child, "SIGTERM");
      this.child.stdin.end();
    }
    this.dashboard.setControl("supervisor", undefined);
    const job = this.dashboard.state.getJob("supervisor");
    if (job && !job.finishedAt) this.dashboard.finishJob("supervisor", "completed", { latestActivity: "Supervisor stopped" });
    if (this.tempDir) await fsp.rm(this.tempDir, { recursive: true, force: true });
    this.child = undefined;
  }
}
