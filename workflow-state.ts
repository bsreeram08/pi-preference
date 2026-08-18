import * as fs from "node:fs/promises";
import * as path from "node:path";

export type WorkflowPlanStatus = "draft" | "approved" | "executing" | "verified" | "blocked";

export interface WorkflowExecutionState {
  startedAt: string;
  completedAt?: string;
  attempts: number;
  verificationPassed: boolean;
  summary?: string;
}

export interface WorkflowPlanState {
  version: 1;
  id: string;
  task: string;
  status: WorkflowPlanStatus;
  plan: string;
  interviewNotes: string;
  createdAt: string;
  updatedAt: string;
  reviewRounds: number;
  planPath: string;
  execution?: WorkflowExecutionState;
}

export interface WorkflowPaths {
  root: string;
  current: string;
  plans: string;
  runs: string;
}

export function getWorkflowPaths(councilStateDir: string): WorkflowPaths {
  const root = path.join(councilStateDir, "workflow");
  return {
    root,
    current: path.join(root, "current.json"),
    plans: path.join(root, "plans"),
    runs: path.join(root, "runs"),
  };
}

export function createWorkflowPlanId(task: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "plan";
  return `${timestamp}-${slug}`;
}

function planDocument(state: WorkflowPlanState): string {
  return `> Status: ${state.status}\n> Plan ID: ${state.id}\n> Updated: ${state.updatedAt}\n\n${state.plan.trim()}\n`;
}

function isPlanState(value: unknown): value is WorkflowPlanState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkflowPlanState>;
  return item.version === 1
    && typeof item.id === "string"
    && typeof item.task === "string"
    && typeof item.plan === "string"
    && typeof item.interviewNotes === "string"
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
    && typeof item.reviewRounds === "number"
    && typeof item.planPath === "string"
    && ["draft", "approved", "executing", "verified", "blocked"].includes(item.status ?? "");
}

export async function ensureWorkflowState(paths: WorkflowPaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.plans, { recursive: true }),
    fs.mkdir(paths.runs, { recursive: true }),
  ]);
}

export async function saveWorkflowPlan(paths: WorkflowPaths, state: WorkflowPlanState): Promise<void> {
  await ensureWorkflowState(paths);
  const planPath = path.join(paths.plans, `${state.id}.md`);
  const normalized: WorkflowPlanState = { ...state, planPath };
  await Promise.all([
    fs.writeFile(planPath, planDocument(normalized), "utf8"),
    fs.writeFile(paths.current, `${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
  ]);
  state.planPath = planPath;
}

export async function loadCurrentWorkflowPlan(paths: WorkflowPaths): Promise<WorkflowPlanState | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(paths.current, "utf8"));
    return isPlanState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeWorkflowRunArtifact(
  paths: WorkflowPaths,
  planId: string,
  name: string,
  content: string,
): Promise<string> {
  const safeName = name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
  const runDir = path.join(paths.runs, planId);
  await fs.mkdir(runDir, { recursive: true });
  const artifactPath = path.join(runDir, safeName.endsWith(".md") ? safeName : `${safeName}.md`);
  await fs.writeFile(artifactPath, `${content.trim()}\n`, "utf8");
  return artifactPath;
}

export function formatWorkflowPlanStatus(state: WorkflowPlanState | undefined): string {
  if (!state) return "No workflow plan exists for this project.";
  const execution = state.execution
    ? `\n- Execution attempts: ${state.execution.attempts}\n- Verification: ${state.execution.verificationPassed ? "passed" : "not passed"}`
    : "";
  return `- Plan: **${state.id}**\n- Status: **${state.status}**\n- Task: ${state.task}\n- Plan file: ${state.planPath}\n- Review rounds: ${state.reviewRounds}${execution}`;
}
