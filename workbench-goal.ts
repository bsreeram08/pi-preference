import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findProjectRoot, getProjectPaths } from "./project.ts";
import type { Exec } from "./types.ts";

export const GOAL_ACTIONS = ["get", "complete", "pause", "resume"] as const;
export type GoalStatus = "active" | "paused" | "complete";

export interface WorkbenchGoal {
  version: 1;
  objective: string;
  status: GoalStatus;
  autoContinue: boolean;
  updatedAt: string;
}

const MAX_OBJECTIVE = 8_000;

export function goalPath(stateDir: string): string {
  return path.join(stateDir, "goal.json");
}

export function parseGoal(value: unknown): WorkbenchGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WorkbenchGoal>;
  if (raw.version !== 1 || typeof raw.objective !== "string" || !raw.objective.trim()) return undefined;
  if (raw.status !== "active" && raw.status !== "paused" && raw.status !== "complete") return undefined;
  return {
    version: 1,
    objective: raw.objective.trim().slice(0, MAX_OBJECTIVE),
    status: raw.status,
    autoContinue: raw.autoContinue === true,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function renderGoal(goal: WorkbenchGoal | undefined): string {
  if (!goal) return "No Workbench goal is set. Use `/goals-set <objective>` to create one. The user owns intent; the agent does not create goals.";
  return [
    `Status: **${goal.status}**`,
    `Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
    "",
    goal.objective,
  ].join("\n");
}

async function readGoalFile(file: string): Promise<WorkbenchGoal | undefined> {
  try {
    return parseGoal(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

async function writeGoalFile(file: string, goal: WorkbenchGoal): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(goal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export function registerWorkbenchGoal(
  pi: ExtensionAPI,
  options: { exec: Exec; report: (title: string, body: string) => void },
): void {
  async function fileFor(cwd: string): Promise<string> {
    const root = await findProjectRoot(cwd, options.exec);
    return goalPath(getProjectPaths(root).stateDir);
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const goal = await readGoalFile(await fileFor(ctx.cwd));
    if (!goal || goal.status !== "active") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nActive Workbench goal (${goal.status}):\n${goal.objective}\nWork only on this goal until it is complete, paused, or the user changes it. Do not invent extra reconnaissance steps.`,
    };
  });

  pi.registerTool({
    name: "workbench_goal",
    label: "Workbench Goal",
    description: "Read or update the current first-party Workbench goal. The user creates goals with /goals-set. Prefer this over third-party pi-goal tools.",
    promptSnippet: "Read or complete the current Workbench goal",
    promptGuidelines: [
      "Use workbench_goal to get/complete/pause/resume the focused goal; do not use third-party pi-goal packages.",
      "Never create a goal from a tool call. The user owns intent via /goals-set.",
      "Do not use mythological goal modes. There is one goal style.",
    ],
    parameters: Type.Object({
      action: StringEnum(GOAL_ACTIONS),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const file = await fileFor(ctx.cwd);
      const current = await readGoalFile(file);
      if (params.action === "get") {
        return { content: [{ type: "text", text: renderGoal(current) }], details: { goal: current ?? null, path: file } };
      }
      if (!current) throw new Error("No Workbench goal is set.");
      if (params.action === "complete") current.status = "complete";
      if (params.action === "pause") current.status = "paused";
      if (params.action === "resume") {
        if (current.status === "complete") throw new Error("Completed goals cannot be resumed; set a new goal.");
        current.status = "active";
      }
      current.updatedAt = new Date().toISOString();
      await writeGoalFile(file, current);
      if (ctx.hasUI) ctx.ui.setStatus("workbench-goal", current.status === "complete" ? undefined : `goal:${current.status}`);
      return { content: [{ type: "text", text: renderGoal(current) }], details: { goal: current, path: file } };
    },
  });

  pi.registerCommand("goals", {
    description: "Show the current first-party Workbench goal",
    handler: async (_rawArgs, ctx) => {
      options.report("Workbench goal", renderGoal(await readGoalFile(await fileFor(ctx.cwd))));
    },
  });

  pi.registerCommand("goals-set", {
    description: "Create or replace the current Workbench goal from the user's objective",
    handler: async (rawArgs, ctx) => {
      const objective = rawArgs.trim();
      if (!objective) {
        options.report("Workbench goal", "Usage: /goals-set <objective>");
        return;
      }
      const file = await fileFor(ctx.cwd);
      const goal: WorkbenchGoal = {
        version: 1,
        objective: objective.slice(0, MAX_OBJECTIVE),
        status: "active",
        autoContinue: false,
        updatedAt: new Date().toISOString(),
      };
      await writeGoalFile(file, goal);
      if (ctx.hasUI) ctx.ui.setStatus("workbench-goal", "goal:active");
      options.report("Workbench goal", renderGoal(goal));
    },
  });

  pi.registerCommand("goals-clear", {
    description: "Remove the current Workbench goal file",
    handler: async (_rawArgs, ctx) => {
      const file = await fileFor(ctx.cwd);
      await fs.rm(file, { force: true });
      if (ctx.hasUI) ctx.ui.setStatus("workbench-goal", undefined);
      options.report("Workbench goal", "Cleared the Workbench goal.");
    },
  });
}
