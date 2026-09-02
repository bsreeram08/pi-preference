import type { AgentRunManager } from "./agent-run-manager.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";
import type { AgentSpec } from "./types.ts";

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

const SUPERVISOR_AGENT: AgentSpec = {
  id: "council-supervisor",
  title: "Council Supervisor",
  description: "Chooses the next evidence-backed council phase without modifying files.",
  triggers: ["council", "orchestration", "decision"],
  readOnly: true,
};

export const SUPERVISOR_SYSTEM_PROMPT = `You are the Council Supervisor, the adaptive orchestrator for a project-scoped coding council.

You do not modify files and you do not run implementation workers directly. Decide what the parent Pi Workbench runtime should delegate next. Inspect the project and use supplied reports as evidence. Re-plan after each result. Choose only relevant specialists; do not include UX unless the intent or changed files have a user-facing interface impact. Pi's installed skills are available through progressive disclosure: for nontrivial decisions, read only the matching SKILL.md files and apply their discipline rather than mechanically invoking every skill. Never claim implementation is verified: an independent verifier and explicit user approval are mandatory.

Return exactly one machine-readable decision and no other fenced JSON:
<workbench-decision>{"action":"delegate|ask_user|synthesize|review|verify|fix|complete","phase":"...","roles":["agent-id"],"rationale":"...","question":"optional","workerCount":2}</workbench-decision>

Use action=delegate for specialist work, review for reviewers, verify for verification, fix for corrective implementation, ask_user when a user decision is required, synthesize when the lead should produce an intent, and complete only when all safety gates are already satisfied. Keep roles relevant and concise.`;

/**
 * Council decision facade over the authoritative AgentRunManager.
 * Each decision is one independently persisted run; supplied council context remains authoritative.
 */
export class SupervisorClient {
  private activeRunId?: string;
  private disposed = false;
  private decisionSequence = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly dashboard: WorkbenchDashboardController,
    private readonly manager: AgentRunManager,
  ) {}

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Supervisor is stopped.");
  }

  async decide(context: string): Promise<SupervisorDecision> {
    if (this.disposed) throw new Error("Supervisor is stopped.");
    if (this.activeRunId) throw new Error("Supervisor decision is already running.");
    const handle = await this.manager.start({
      projectRoot: this.projectRoot,
      agent: SUPERVISOR_AGENT,
      systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
      task: context,
      runId: `council-supervisor-${++this.decisionSequence}`,
      runContext: {
        dashboard: this.dashboard,
        groupId: "supervisor",
        groupTitle: "Supervisor",
        budget: { turns: 16, tools: 60 },
      },
    });
    this.activeRunId = handle.runId;
    try {
      try { this.manager.focus(handle.runId); } catch { /* Presentation focus is non-authoritative. */ }
      this.dashboard.updateJob(handle.runId, { latestActivity: "Leader is choosing the next council step" });
      const result = await handle.completion;
      if (result.cancelled) throw new Error("Supervisor decision was cancelled.");
      if (result.exitCode !== 0 || !result.output.trim()) throw new Error(result.error || "Supervisor decision failed.");
      const decision = parseSupervisorDecision(result.output);
      if (!decision) throw new Error(`Supervisor returned an invalid decision: ${result.output.slice(0, 500)}`);
      this.dashboard.updateJob(handle.runId, { latestActivity: `${decision.action}: ${decision.phase}`, output: truncate(result.output) });
      return decision;
    } finally {
      this.activeRunId = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.activeRunId) await this.manager.cancel(this.activeRunId);
    this.activeRunId = undefined;
  }
}
