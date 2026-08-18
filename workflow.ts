import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  WORKFLOW_AGENT_IDS,
  formatWorkflowRoster,
  getWorkflowAgentProfile,
  resolveWorkflowAgent,
  selectPlanningDiscoveryAgentIds,
  validateParallelWorkflowAgents,
  type WorkflowAgentId,
  type WorkflowAgentProfile,
} from "./workflow-agents.ts";
import {
  executionManagerReportsBlocker,
  buildExecutionBriefTask,
  buildClearanceTask,
  buildCodeReviewTask,
  buildWorkflowSystemPrompt,
  buildDiscoveryTask,
  buildFixTask,
  buildImplementationTask,
  buildIndependentVerificationTask,
  buildRequirementsAnalysisTask,
  buildPlanReviewTask,
  buildPlanRevisionTask,
  buildPlannerTask,
  codeReviewsPass,
  parsePlanningClearance,
  planReviewsPass,
  verificationPasses,
  type PlanningClearance,
} from "./workflow-prompts.ts";
import {
  createWorkflowPlanId,
  formatWorkflowPlanStatus,
  getWorkflowPaths,
  loadCurrentWorkflowPlan,
  saveWorkflowPlan,
  writeWorkflowRunArtifact,
  type WorkflowPlanState,
} from "./workflow-state.ts";
import { loadConfig, type WorkbenchConfig } from "./config.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";
import { ensureProjectState, findProjectRoot, getProjectPaths } from "./project.ts";
import { getCommunityKnowledgePath } from "./skill-evolution.ts";
import { runSingleAgent } from "./subagents.ts";
import type { AgentResult, AgentSpec, Exec } from "./types.ts";
import { formatAgentResults } from "./prompts.ts";

interface WorkflowDependencies {
  exec: Exec;
  dashboard: WorkbenchDashboardController;
  reprompterPath: string;
  report(title: string, body: string): void;
}

interface Progress {
  update(message: string): void;
  clear(): void;
}

interface PlanningResult {
  state?: WorkflowPlanState;
  cancelled: boolean;
  executable: boolean;
}

interface DelegationToolDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
}

const TaskItemSchema = Type.Object({
  agent: StringEnum(WORKFLOW_AGENT_IDS, { description: "Specialized workflow agent" }),
  task: Type.String({ description: "Focused task with expected output and success criteria" }),
});

function now(): string {
  return new Date().toISOString();
}

function progressFor(ctx: ExtensionContext, title: string): Progress {
  return {
    update(message) {
      if (ctx.hasUI) ctx.ui.setStatus("workflow", `${title}: ${message}`);
    },
    clear() {
      if (ctx.hasUI) ctx.ui.setStatus("workflow", undefined);
    },
  };
}

function shortened(text: string, limit = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function fallbackClearance(output: string): PlanningClearance {
  return {
    ready: true,
    questions: [],
    assumptions: [`Planner did not return structured clearance; dual review must scrutinize this assessment: ${shortened(output, 240)}`],
  };
}

function createPlanState(id: string, task: string, plan: string, interviewNotes: string): WorkflowPlanState {
  const timestamp = now();
  return {
    version: 1,
    id,
    task,
    status: "draft",
    plan,
    interviewNotes,
    createdAt: timestamp,
    updatedAt: timestamp,
    reviewRounds: 0,
    planPath: "",
  };
}

function taskWithUserAnswers(questions: string[], answer: string, round: number): string {
  return `## Interview round ${round}\n\nQuestions:\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}\n\nUser response:\n${answer.trim()}`;
}

function planReviewText(results: AgentResult[]): string {
  return formatAgentResults(results);
}

function agentJobId(phase: string, role: string, suffix?: string | number): string {
  return `workflow-${phase}-${role}${suffix === undefined ? "" : `-${suffix}`}`;
}

async function getTaskInput(rawArgs: string, ctx: ExtensionCommandContext, title: string): Promise<string> {
  const explicit = rawArgs.trim();
  if (explicit) return explicit;
  if (!ctx.hasUI) return "";
  return (await ctx.ui.editor(title, "Describe the outcome, constraints, non-goals, and what observable result would count as done."))?.trim() ?? "";
}

function renderAgentResult(result: AgentResult): string {
  const status = result.exitCode === 0 ? "completed" : `failed: ${result.error ?? `exit ${result.exitCode}`}`;
  return `## ${result.title} — ${status}\n\n${result.output}`;
}

export function registerWorkflow(pi: ExtensionAPI, dependencies: WorkflowDependencies): void {
  const { dashboard, exec, reprompterPath, report } = dependencies;
  const communityKnowledgePath = getCommunityKnowledgePath();

  async function resolveProject(ctx: ExtensionContext): Promise<{
    root: string;
    paths: ReturnType<typeof getProjectPaths>;
    workflowPaths: ReturnType<typeof getWorkflowPaths>;
    config: WorkbenchConfig;
  }> {
    const root = await findProjectRoot(ctx.cwd, exec);
    const paths = getProjectPaths(root);
    await ensureProjectState(paths);
    return { root, paths, workflowPaths: getWorkflowPaths(paths.stateDir), config: await loadConfig(paths) };
  }

  async function runRole(
    root: string,
    config: WorkbenchConfig,
    role: WorkflowAgentId,
    userTask: string,
    delegatedTask: string,
    progress: Progress,
    groupId: string,
    groupTitle: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const agent = resolveWorkflowAgent(role, config);
    if (!agent) throw new Error(`Unknown workflow agent: ${role}`);
    return runSingleAgent(
      root,
      agent,
      buildWorkflowSystemPrompt(agent, reprompterPath, userTask, communityKnowledgePath),
      delegatedTask,
      signal,
      progress.update,
      { dashboard, groupId, groupTitle, jobId },
    );
  }

  async function runRoleBatch(
    root: string,
    config: WorkbenchConfig,
    tasks: Array<{ role: WorkflowAgentId; task: string }>,
    userTask: string,
    progress: Progress,
    groupId: string,
    groupTitle: string,
    signal?: AbortSignal,
  ): Promise<AgentResult[]> {
    if (tasks.length > config.workflowMaxParallelAgents) {
      throw new Error(`Workflow parallel limit is ${config.workflowMaxParallelAgents}; received ${tasks.length}.`);
    }
    const profiles = tasks.map(({ role }) => {
      const profile = resolveWorkflowAgent(role, config);
      if (!profile) throw new Error(`Unknown workflow agent: ${role}`);
      return profile;
    });
    const parallelError = tasks.length > 1 ? validateParallelWorkflowAgents(profiles) : undefined;
    if (parallelError) throw new Error(parallelError);
    return Promise.all(tasks.map(({ role, task }, index) => runRole(
      root,
      config,
      role,
      userTask,
      task,
      progress,
      groupId,
      groupTitle,
      agentJobId(groupId, role, index + 1),
      signal,
    )));
  }

  async function reviewPlan(
    root: string,
    config: WorkbenchConfig,
    task: string,
    plan: string,
    progress: Progress,
    round: number | string,
  ): Promise<AgentResult[]> {
    progress.update(`plan review ${round}: Quality Reviewer and Technical Reviewer running independently`);
    return runRoleBatch(
      root,
      config,
      [
        { role: "quality-reviewer", task: buildPlanReviewTask("quality-reviewer", task, plan) },
        { role: "technical-reviewer", task: buildPlanReviewTask("technical-reviewer", task, plan) },
      ],
      task,
      progress,
      `plan-review-${round}`,
      `Plan review ${round}`,
    );
  }

  async function createPlan(
    root: string,
    projectPaths: ReturnType<typeof getProjectPaths>,
    config: WorkbenchConfig,
    task: string,
    ctx: ExtensionCommandContext,
    progress: Progress,
    options: { autonomous: boolean; autoApprove: boolean },
  ): Promise<PlanningResult> {
    const workflowPaths = getWorkflowPaths(projectPaths.stateDir);
    const id = createWorkflowPlanId(task);
    const discoveryRoles = selectPlanningDiscoveryAgentIds(task);
    progress.update(`discovery: ${discoveryRoles.join(" + ")}`);
    const discoveryResults = await runRoleBatch(
      root,
      config,
      discoveryRoles.map((role) => ({ role, task: buildDiscoveryTask(task, role as "codebase-explorer" | "researcher") })),
      task,
      progress,
      "planning-discovery",
      "Planning discovery",
    );
    const discovery = formatAgentResults(discoveryResults);
    await writeWorkflowRunArtifact(workflowPaths, id, "discovery.md", discovery);

    let interviewNotes = "";
    let clearance: PlanningClearance = { ready: false, questions: [], assumptions: [] };
    for (let round = 0; round <= config.workflowMaxInterviewRounds; round++) {
      progress.update(`Planner clearance assessment ${round + 1}`);
      const result = await runRole(
        root,
        config,
        "planner",
        task,
        buildClearanceTask(task, discovery, interviewNotes, options.autonomous),
        progress,
        "planning-clearance",
        "Planner interview",
        agentJobId("clearance", "planner", round + 1),
      );
      await writeWorkflowRunArtifact(workflowPaths, id, `clearance-${round + 1}.md`, result.output);
      clearance = parsePlanningClearance(result.output) ?? fallbackClearance(result.output);
      if (clearance.ready) break;

      if (options.autonomous) {
        const blocked = createPlanState(
          id,
          task,
          `# Planning blocked\n\nPlanner found a critical ambiguity that autonomous assumptions cannot safely resolve.\n\n${result.output}`,
          interviewNotes,
        );
        blocked.status = "blocked";
        blocked.updatedAt = now();
        await saveWorkflowPlan(workflowPaths, blocked);
        return { state: blocked, cancelled: false, executable: false };
      }
      if (round >= config.workflowMaxInterviewRounds) break;
      const answer = await ctx.ui.editor(
        `Planner interview — round ${round + 1}`,
        `${clearance.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}\n\nWrite your answers below:\n`,
      );
      if (answer === undefined) return { cancelled: true, executable: false };
      interviewNotes += `${interviewNotes ? "\n\n" : ""}${taskWithUserAnswers(clearance.questions, answer, round + 1)}`;
    }

    if (!clearance.ready) {
      const proceed = await ctx.ui.confirm(
        "Planner still sees unresolved decisions",
        "Continue by recording them as explicit assumptions? Quality Reviewer and Technical Reviewer will independently review the resulting plan.",
      );
      if (!proceed) return { cancelled: true, executable: false };
      clearance = {
        ready: true,
        questions: [],
        assumptions: [...clearance.assumptions, ...clearance.questions.map((question) => `Unresolved question treated conservatively: ${question}`)],
      };
    }

    progress.update("Requirements Analyst checking hidden gaps and scope");
    const requirementsAnalysis = await runRole(
      root,
      config,
      "requirements-analyst",
      task,
      buildRequirementsAnalysisTask(task, discovery, interviewNotes, clearance),
      progress,
      "planning-gap-analysis",
      "Requirements Analyst gap analysis",
      agentJobId("gap-analysis", "requirements-analyst"),
    );
    await writeWorkflowRunArtifact(workflowPaths, id, "requirements-analysis.md", requirementsAnalysis.output);

    progress.update("Planner writing decision-complete plan");
    let planResult = await runRole(
      root,
      config,
      "planner",
      task,
      buildPlannerTask(task, discovery, interviewNotes, requirementsAnalysis.output),
      progress,
      "planning-synthesis",
      "Planner plan",
      agentJobId("plan", "planner", 1),
    );
    let plan = planResult.output;
    let state = createPlanState(id, task, plan, interviewNotes);
    await saveWorkflowPlan(workflowPaths, state);

    let reviews: AgentResult[] = [];
    for (let round = 1; round <= config.workflowMaxPlanReviewLoops; round++) {
      reviews = await reviewPlan(root, config, task, plan, progress, round);
      state.reviewRounds = round;
      state.updatedAt = now();
      await writeWorkflowRunArtifact(workflowPaths, id, `plan-review-${round}.md`, planReviewText(reviews));
      if (planReviewsPass(reviews)) break;
      if (round >= config.workflowMaxPlanReviewLoops) {
        state.status = "blocked";
        state.plan = plan;
        await saveWorkflowPlan(workflowPaths, state);
        report("Workflow plan blocked", `Quality Reviewer or Technical Reviewer still found a verified blocker after ${round} review rounds.\n\n${planReviewText(reviews)}\n\nDraft: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      progress.update(`Planner revising rejected plan — round ${round}`);
      planResult = await runRole(
        root,
        config,
        "planner",
        task,
        buildPlanRevisionTask(task, plan, planReviewText(reviews)),
        progress,
        "planning-revision",
        "Planner revision",
        agentJobId("plan-revision", "planner", round),
      );
      plan = planResult.output;
      state.plan = plan;
      await saveWorkflowPlan(workflowPaths, state);
    }

    if (options.autoApprove) {
      state.status = "approved";
      state.plan = plan;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      return { state, cancelled: false, executable: true };
    }

    const edited = await ctx.ui.editor("Review implementation plan", plan);
    if (edited === undefined) {
      state.status = "draft";
      state.plan = plan;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      return { state, cancelled: true, executable: false };
    }
    const editedPlan = edited.trim();
    if (!editedPlan) return { state, cancelled: true, executable: false };
    if (editedPlan !== plan.trim()) {
      state.plan = editedPlan;
      state.status = "draft";
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      const editedReviews = await reviewPlan(root, config, task, editedPlan, progress, "user-edit");
      state.reviewRounds += 1;
      await writeWorkflowRunArtifact(workflowPaths, id, "plan-review-user-edit.md", planReviewText(editedReviews));
      if (!planReviewsPass(editedReviews)) {
        await saveWorkflowPlan(workflowPaths, state);
        report("Edited plan needs revision", `The user-edited plan remains a draft because an independent reviewer found a blocker.\n\n${planReviewText(editedReviews)}\n\nDraft: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      plan = editedPlan;
    }

    const approved = await ctx.ui.confirm(
      "Approve this workflow plan?",
      "Approval makes it executable by /start-work. Source files have not been changed yet.",
    );
    state.plan = plan;
    state.status = approved ? "approved" : "draft";
    state.updatedAt = now();
    await saveWorkflowPlan(workflowPaths, state);
    return { state, cancelled: false, executable: approved };
  }

  async function executePlan(
    root: string,
    projectPaths: ReturnType<typeof getProjectPaths>,
    config: WorkbenchConfig,
    state: WorkflowPlanState,
    progress: Progress,
  ): Promise<boolean> {
    const workflowPaths = getWorkflowPaths(projectPaths.stateDir);
    state.status = "executing";
    state.updatedAt = now();
    state.execution = {
      startedAt: now(),
      attempts: 0,
      verificationPassed: false,
    };
    await saveWorkflowPlan(workflowPaths, state);

    progress.update("Execution Manager sequencing approved work");
    const executionManager = await runRole(
      root,
      config,
      "execution-manager",
      state.task,
      buildExecutionBriefTask(state.task, state.plan),
      progress,
      "execution-management",
      "Execution management",
      agentJobId("execution", "execution-manager"),
    );
    await writeWorkflowRunArtifact(workflowPaths, state.id, "execution-brief.md", executionManager.output);
    if (executionManager.exitCode !== 0 || executionManagerReportsBlocker(executionManager.output)) {
      state.status = "blocked";
      state.execution.summary = "Execution Manager reported a pre-implementation blocker.";
      state.execution.completedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      report("Workflow execution blocked", `${executionManager.output}\n\nPlan: ${state.planPath}`);
      return false;
    }

    progress.update("Implementer implementing the approved plan");
    let implementation = await runRole(
      root,
      config,
      "implementer",
      state.task,
      buildImplementationTask(state.task, state.plan, executionManager.output),
      progress,
      "execution-worker",
      "Implementer implementation",
      agentJobId("implementation", "implementer", 1),
    );
    await writeWorkflowRunArtifact(workflowPaths, state.id, "implementation-1.md", implementation.output);

    const verifierBase = resolveWorkflowAgent("quality-reviewer", config);
    if (!verifierBase) throw new Error("Quality Reviewer model route is unavailable for independent verification.");
    const verifier: AgentSpec = {
      ...verifierBase,
      id: "workflow-verifier",
      title: "Independent Verification Gate",
      description: "Runs canonical checks independently and refuses unsupported completion claims.",
      readOnly: true,
      allowBash: true,
    };

    for (let attempt = 0; attempt <= config.workflowMaxFixLoops; attempt++) {
      const cycle = attempt + 1;
      state.execution.attempts = cycle;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);

      progress.update(`review cycle ${cycle}: Quality Reviewer and Technical Reviewer`);
      const reviews = await runRoleBatch(
        root,
        config,
        [
          { role: "quality-reviewer", task: buildCodeReviewTask("quality-reviewer", state.task, state.plan, implementation.output) },
          { role: "technical-reviewer", task: buildCodeReviewTask("technical-reviewer", state.task, state.plan, implementation.output) },
        ],
        state.task,
        progress,
        `execution-review-${cycle}`,
        `Execution review ${cycle}`,
      );
      const reviewsText = formatAgentResults(reviews);
      await writeWorkflowRunArtifact(workflowPaths, state.id, `reviews-${cycle}.md`, reviewsText);

      progress.update(`verification cycle ${cycle}: canonical checks`);
      const verification = await runSingleAgent(
        root,
        verifier,
        buildWorkflowSystemPrompt(verifierBase, reprompterPath, state.task, communityKnowledgePath),
        buildIndependentVerificationTask(state.task, state.plan, implementation.output),
        undefined,
        progress.update,
        {
          dashboard,
          groupId: `execution-verification-${cycle}`,
          groupTitle: `Verification ${cycle}`,
          jobId: agentJobId("verification", "gate", cycle),
        },
      );
      await writeWorkflowRunArtifact(workflowPaths, state.id, `verification-${cycle}.md`, verification.output);

      if (codeReviewsPass(reviews) && verification.exitCode === 0 && verificationPasses(verification.output)) {
        state.status = "verified";
        state.updatedAt = now();
        state.execution.verificationPassed = true;
        state.execution.completedAt = now();
        state.execution.summary = `Verified after ${cycle} review cycle${cycle === 1 ? "" : "s"}.`;
        await saveWorkflowPlan(workflowPaths, state);
        report("Workflow work verified", `The approved plan was implemented and independently verified.\n\n${verification.output}\n\nPlan: ${state.planPath}\nRun evidence: ${pathJoinForDisplay(workflowPaths.runs, state.id)}`);
        return true;
      }

      if (attempt >= config.workflowMaxFixLoops) {
        state.status = "blocked";
        state.updatedAt = now();
        state.execution.completedAt = now();
        state.execution.summary = `Verification did not pass after ${cycle} cycles.`;
        await saveWorkflowPlan(workflowPaths, state);
        report("Workflow work not verified", `The workflow exhausted its bounded fix loops and refuses to claim completion.\n\n${reviewsText}\n\n${verification.output}\n\nPlan: ${state.planPath}`);
        return false;
      }

      progress.update(`Implementer fixing cycle ${cycle}`);
      implementation = await runRole(
        root,
        config,
        "implementer",
        state.task,
        buildFixTask(state.task, state.plan, implementation.output, reviewsText, verification.output),
        progress,
        `execution-fix-${cycle}`,
        `Fix cycle ${cycle}`,
        agentJobId("fix", "implementer", cycle),
      );
      await writeWorkflowRunArtifact(workflowPaths, state.id, `implementation-${cycle + 1}.md`, implementation.output);
    }
    return false;
  }

  function pathJoinForDisplay(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  async function runPlanningCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      report("Planner unavailable", "`/plan` requires interactive UI for its interview and approval checkpoints.");
      return;
    }
    const task = await getTaskInput(rawArgs, ctx, "Planner planning request");
    if (!task) return;
    const project = await resolveProject(ctx);
    const confirmed = await ctx.ui.confirm(
      "Start high-accuracy Workflow planning?",
      `Pi will run discovery, a bounded Planner interview, Requirements Analyst gap analysis, and up to ${project.config.workflowMaxPlanReviewLoops} Quality Reviewer + Technical Reviewer review rounds. No source files will be changed.`,
    );
    if (!confirmed) return;

    dashboard.beginRun(`workflow-plan-${Date.now()}`);
    const progress = progressFor(ctx, "Planner");
    try {
      const result = await createPlan(project.root, project.paths, project.config, task, ctx, progress, { autonomous: false, autoApprove: false });
      if (result.state) {
        report(
          result.state.status === "approved" ? "Workflow plan approved" : "Workflow plan saved",
          `${formatWorkflowPlanStatus(result.state)}\n\n${result.state.status === "approved" ? "Run `/start-work` when ready." : "Revise or rerun `/plan` before execution."}`,
        );
      }
    } catch (error) {
      report("Workflow planning interrupted", `${error instanceof Error ? error.message : String(error)}\n\nNo implementation was started.`);
    } finally {
      progress.clear();
      dashboard.endRun();
    }
  }

  async function runStartWorkCommand(_rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      report("Execution Manager unavailable", "`/start-work` requires interactive UI for the write confirmation.");
      return;
    }
    const project = await resolveProject(ctx);
    const state = await loadCurrentWorkflowPlan(project.workflowPaths);
    if (!state) {
      report("No workflow plan", "Run `/plan <task>` first.");
      return;
    }
    if (state.status !== "approved") {
      report("Plan is not executable", `${formatWorkflowPlanStatus(state)}\n\nOnly an approved plan can run. Use \`/plan\` to review or replace it.`);
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Start approved work?",
      `Implementer will modify the current working tree, followed by independent review and up to ${project.config.workflowMaxFixLoops} fix loops. Existing unrelated changes must be preserved.`,
    );
    if (!confirmed) return;

    dashboard.beginRun(`workflow-execute-${Date.now()}`);
    const progress = progressFor(ctx, "Execution Manager");
    try {
      await executePlan(project.root, project.paths, project.config, state, progress);
    } catch (error) {
      state.status = "blocked";
      state.updatedAt = now();
      if (state.execution) {
        state.execution.completedAt = now();
        state.execution.summary = error instanceof Error ? error.message : String(error);
      }
      await saveWorkflowPlan(project.workflowPaths, state);
      report("Workflow execution interrupted", `${error instanceof Error ? error.message : String(error)}\n\nThe work is not marked complete.`);
    } finally {
      progress.clear();
      dashboard.endRun();
    }
  }

  async function runAutopilotCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      report("Autopilot unavailable", "`/autopilot` requires interactive UI for its initial cost and write confirmation.");
      return;
    }
    const task = await getTaskInput(rawArgs, ctx, "Autopilot request");
    if (!task) return;
    const project = await resolveProject(ctx);
    const confirmed = await ctx.ui.confirm(
      "Start autopilot?",
      `The Coordinator will plan with explicit conservative assumptions, run dual plan review, then let the Execution Manager and Implementer modify the working tree and verify it. Limits: ${project.config.workflowMaxPlanReviewLoops} plan-review rounds and ${project.config.workflowMaxFixLoops} fix loops.`,
    );
    if (!confirmed) return;

    dashboard.beginRun(`workflow-autopilot-${Date.now()}`);
    const progress = progressFor(ctx, "Autopilot");
    try {
      const planning = await createPlan(project.root, project.paths, project.config, task, ctx, progress, { autonomous: true, autoApprove: true });
      if (!planning.state || !planning.executable) {
        report("Autopilot stopped at planning", planning.state ? formatWorkflowPlanStatus(planning.state) : "Planning was cancelled.");
        return;
      }
      await executePlan(project.root, project.paths, project.config, planning.state, progress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await loadCurrentWorkflowPlan(project.workflowPaths);
      if (current && current.status !== "verified") {
        current.status = "blocked";
        current.updatedAt = now();
        if (current.execution) {
          current.execution.completedAt = now();
          current.execution.summary = message;
        }
        await saveWorkflowPlan(project.workflowPaths, current);
      }
      report("Autopilot interrupted", `${message}\n\nThe Coordinator refuses to claim completion without the verification gate.`);
    } finally {
      progress.clear();
      dashboard.endRun();
    }
  }

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Delegate a focused task to one named specialist or run multiple read-only specialists in parallel. Write-capable agents must run alone. Output is capped by the Workbench subagent runner at 50KB per agent.",
    promptSnippet: "Delegate focused work to Pi's specialized workflow agents",
    promptGuidelines: [
      "Use delegate_task when isolated specialist context or independent parallel analysis materially improves a complex task; keep simple work in the main Pi agent.",
      "Main Pi acts as Coordinator: delegate bounded outcomes with context and success criteria, then verify returned claims against the actual project.",
      "Before delegating, choose a named role by capability rather than by model. Never run Implementer or Task Implementer in a parallel delegate_task batch.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(StringEnum(WORKFLOW_AGENT_IDS, { description: "Agent for single delegation" })),
      task: Type.Optional(Type.String({ description: "Task for single delegation" })),
      tasks: Type.Optional(Type.Array(TaskItemSchema, { minItems: 1, maxItems: 6, description: "Read-only tasks to run in parallel" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<DelegationToolDetails>> {
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      if (Number(hasSingle) + Number(hasParallel) !== 1) throw new Error("Provide exactly one mode: agent + task, or tasks[].");
      const project = await resolveProject(ctx);
      const ownsRun = !dashboard.state.currentRunId;
      if (ownsRun) dashboard.beginRun(`workflow-tool-${Date.now()}`);
      const progress = progressFor(ctx, "Delegation");
      try {
        if (params.tasks?.length) {
          const profiles = params.tasks.map((item) => resolveWorkflowAgent(item.agent, project.config)).filter((item): item is WorkflowAgentProfile => Boolean(item));
          const safetyError = validateParallelWorkflowAgents(profiles);
          if (safetyError) throw new Error(safetyError);
          onUpdate?.({
            content: [{ type: "text", text: `Running ${params.tasks.length} read-only specialists in parallel…` }],
            details: { mode: "parallel", results: [] },
          });
          const results = await runRoleBatch(
            project.root,
            project.config,
            params.tasks.map((item) => ({ role: item.agent, task: item.task })),
            params.tasks.map((item) => item.task).join("\n"),
            progress,
            `tool-parallel-${Date.now()}`,
            "Delegation",
            signal,
          );
          return {
            content: [{ type: "text", text: formatAgentResults(results) }],
            details: { mode: "parallel", results },
          };
        }
        const role = params.agent as WorkflowAgentId;
        const profile = resolveWorkflowAgent(role, project.config);
        if (!profile) throw new Error(`Unknown workflow agent: ${String(params.agent)}`);
        const task = params.task ?? "";
        onUpdate?.({
          content: [{ type: "text", text: `${profile.title} is working…` }],
          details: { mode: "single", results: [] },
        });
        const result = await runRole(
          project.root,
          project.config,
          role,
          task,
          task,
          progress,
          `tool-single-${Date.now()}`,
          "Delegation",
          agentJobId("tool", role, Date.now()),
          signal,
        );
        return { content: [{ type: "text", text: renderAgentResult(result) }], details: { mode: "single", results: [result] } };
      } finally {
        progress.clear();
        if (ownsRun) dashboard.endRun();
      }
    },
    renderCall(args, theme) {
      if (args.tasks?.length) {
        return new Text(`${theme.fg("toolTitle", theme.bold("delegate_task "))}${theme.fg("accent", `${args.tasks.length} read-only agents`)}`, 0, 0);
      }
      return new Text(`${theme.fg("toolTitle", theme.bold("delegate_task "))}${theme.fg("accent", args.agent ?? "agent")}${theme.fg("dim", ` ${shortened(args.task ?? "")}`)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const text = result.content.find((item) => item.type === "text");
      if (isPartial) return new Text(theme.fg("warning", text?.type === "text" ? text.text : "Delegating…"), 0, 0);
      const details = result.details as { results?: AgentResult[] } | undefined;
      const results = details?.results ?? [];
      const succeeded = results.filter((item) => item.exitCode === 0).length;
      return new Text(
        `${succeeded === results.length ? theme.fg("success", "✓") : theme.fg("warning", "◐")} ${theme.fg("toolTitle", `Delegation ${succeeded}/${results.length || 1}`)}${theme.fg("muted", " — expand for full reports")}`,
        0,
        0,
      );
    },
  });

  pi.registerCommand("delegate", {
    description: "Show the specialist roster, or run one specialist: /delegate <agent> <task>",
    handler: async (rawArgs, ctx) => {
      const [rawRole, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
      const project = await resolveProject(ctx);
      if (!rawRole) {
        const state = await loadCurrentWorkflowPlan(project.workflowPaths);
        report("Pi workflow", `${formatWorkflowPlanStatus(state)}\n\n## Specialist roster\n${formatWorkflowRoster(project.config)}\n\n## Commands\n- \`/plan <task>\` — interview and produce a reviewed plan\n- \`/start-work\` — execute the approved plan\n- \`/autopilot <task>\` — autonomous planning and execution\n- \`/preferences\` — durable personalization\n- \`/skills-evolve\` — trusted skill synchronization`);
        return;
      }
      const profile = getWorkflowAgentProfile(rawRole);
      if (!profile) {
        report("Unknown workflow agent", `Available: ${WORKFLOW_AGENT_IDS.join(", ")}`);
        return;
      }
      let task = rest.join(" ").trim();
      if (!task && ctx.hasUI) task = (await ctx.ui.editor(profile.title, "Describe the focused delegated outcome and success criteria."))?.trim() ?? "";
      if (!task) return;
      if (!profile.readOnly && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(`Run ${profile.title}?`, "This specialist can modify the current working tree. It will run alone.");
        if (!confirmed) return;
      }
      dashboard.beginRun(`workflow-command-${Date.now()}`);
      const progress = progressFor(ctx, profile.title);
      try {
        const resolved = resolveWorkflowAgent(profile.id, project.config)!;
        const result = await runRole(
          project.root,
          project.config,
          resolved.id,
          task,
          task,
          progress,
          "manual-specialist",
          "Manual specialist",
          agentJobId("manual", profile.id, Date.now()),
        );
        report(profile.title, renderAgentResult(result));
      } catch (error) {
        report(`${profile.title} failed`, error instanceof Error ? error.message : String(error));
      } finally {
        progress.clear();
        dashboard.endRun();
      }
    },
  });

  pi.registerCommand("workflow-status", {
    description: "Show the current plan status and evidence paths",
    handler: async (_args, ctx) => {
      const project = await resolveProject(ctx);
      const state = await loadCurrentWorkflowPlan(project.workflowPaths);
      report("Workflow status", `${formatWorkflowPlanStatus(state)}\n\n- State directory: ${project.workflowPaths.root}\n- Community hypothesis feed: ${communityKnowledgePath}`);
    },
  });

  pi.registerCommand("plan", {
    description: "Interview, research, and produce a dual-reviewed implementation plan without changing source files",
    handler: runPlanningCommand,
  });

  pi.registerCommand("start-work", {
    description: "Execute the current approved plan through execution management, implementation, review, and verification",
    handler: runStartWorkCommand,
  });

  pi.registerCommand("autopilot", {
    description: "Autonomously plan, implement, review, fix, and verify a complex task",
    handler: runAutopilotCommand,
  });
}
