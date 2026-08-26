import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchDashboardController } from "../dashboard-controller.ts";
import { ExclusiveLeaseError } from "../exclusive-lease.ts";
import { registerWorkflow } from "../workflow.ts";
import { getWorkflowPaths, loadCurrentWorkflowPlan, saveWorkflowPlan, type WorkflowPlanState } from "../workflow-state.ts";
import type { AgentResult, AgentSpec, Exec } from "../types.ts";

interface Harness {
  readonly root: string;
  readonly commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  readonly tools: Map<string, any>;
  readonly reports: Array<{ title: string; body: string }>;
  readonly dashboard: WorkbenchDashboardController;
}

async function harness(
  runAgent: (agent: AgentSpec, call: number) => Promise<AgentResult>,
  options: { abortOnBegin?: boolean; blockLease?: boolean; beforeLeaseWork?: (root: string) => Promise<void> } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-orchestration-"));
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const reports: Array<{ title: string; body: string }> = [];
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command.handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    appendEntry() {},
    events: { emit() {} },
  } as any;
  const dashboard = new WorkbenchDashboardController(pi);
  if (options.abortOnBegin) {
    const original = dashboard.beginRun.bind(dashboard);
    dashboard.beginRun = ((runId: string, controller?: AbortController) => {
      original(runId, controller);
      controller?.abort();
    }) as typeof dashboard.beginRun;
  }
  let calls = 0;
  const exec: Exec = async () => ({ stdout: `${root}\n`, stderr: "", code: 0 });
  registerWorkflow(pi, {
    exec,
    dashboard,
    reprompterPath: path.join(root, "SKILL.md"),
    report(title, body) { reports.push({ title, body }); },
    getRoutingState: () => ({ policy: "balanced" }),
    runAgent: async (_projectRoot, agent) => runAgent(agent, ++calls),
    ...(options.blockLease || options.beforeLeaseWork ? {
      withLease: async (_projectRoot: string, _operation: string, work: () => Promise<unknown>) => {
        if (options.blockLease) throw new ExclusiveLeaseError("writer_live", "live");
        await options.beforeLeaseWork?.(root);
        return work();
      },
    } : {}),
  });
  return { root, commands, tools, reports, dashboard };
}

function context(root: string, confirm: () => Promise<boolean> = async () => true): any {
  return {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      confirm,
      editor: async () => "approved input",
      setStatus() {},
    },
  };
}

function agentResult(agent: AgentSpec, output = "valid output", overrides: Partial<AgentResult> = {}): AgentResult {
  return { agentId: agent.id, title: agent.title, output, exitCode: 0, ...overrides };
}

async function approvedState(root: string, id = "approved-plan", task = "Implement approved work"): Promise<void> {
  const state: WorkflowPlanState = {
    version: 1,
    id,
    task,
    status: "approved",
    plan: "# Plan\n\nImplement.",
    interviewNotes: "",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    reviewRounds: 1,
    planPath: "",
  };
  await saveWorkflowPlan(getWorkflowPaths(path.join(root, ".pi", "pi-workbench")), state);
}

describe("workflow orchestration fail-closed behavior", () => {
  for (const scenario of [
    { name: "nonzero discovery", result: (agent: AgentSpec) => agentResult(agent, "failed", { exitCode: 1 }), status: "interrupted" },
    { name: "cancelled exit-zero discovery", result: (agent: AgentSpec) => agentResult(agent, "cancelled", { cancelled: true }), status: "cancelled" },
    { name: "blank discovery", result: (agent: AgentSpec) => agentResult(agent, "  "), status: "interrupted" },
  ]) {
    test(`${scenario.name} does not launch clearance`, async () => {
      let calls = 0;
      const testHarness = await harness(async (agent) => { calls++; return scenario.result(agent); });
      try {
        await testHarness.commands.get("plan")?.("local rename", context(testHarness.root));
        expect(calls).toBe(1);
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        expect(state?.status).toBe(scenario.status);
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    });
  }

  test("one failed discovery batch member prevents clearance", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => {
      calls++;
      return agentResult(agent, agent.id === "researcher" ? "failed" : "discovered", agent.id === "researcher" ? { exitCode: 2 } : {});
    });
    try {
      await testHarness.commands.get("plan")?.("integrate latest SDK documentation", context(testHarness.root));
      expect(calls).toBe(2);
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench"))))?.status).toBe("interrupted");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("malformed clearance blocks before requirements analysis", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent, call) => {
      calls++;
      return agentResult(agent, call === 1 ? "discovery evidence" : "clearance omitted");
    });
    try {
      await testHarness.commands.get("plan")?.("local rename", context(testHarness.root));
      expect(calls).toBe(2);
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench"))))?.status).toBe("blocked");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("run-level cancellation persists cancelled and launches no child", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => { calls++; return agentResult(agent); }, { abortOnBegin: true });
    try {
      await testHarness.commands.get("plan")?.("local rename", context(testHarness.root));
      expect(calls).toBe(0);
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench"))))?.status).toBe("cancelled");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  for (const blockerOutput of [
    "Execution brief without the required section",
    "## Blockers\n\n## Sequence\n1. Work",
    "## Blockers\nNone\n## Blockers\nNone",
  ]) {
    test("invalid execution blocker verdict prevents Implementer launch", async () => {
      let calls = 0;
      const testHarness = await harness(async (agent) => { calls++; return agentResult(agent, blockerOutput); });
      try {
        await approvedState(testHarness.root);
        await testHarness.commands.get("start-work")?.("", context(testHarness.root));
        expect(calls).toBe(1);
        expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench"))))?.status).toBe("blocked");
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    });
  }
});

describe("authoritative workflow confirmation snapshots", () => {
  test("plan mismatch leaves the replacement state untouched and launches no child", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => { calls++; return agentResult(agent); });
    try {
      await approvedState(testHarness.root, "initial-plan", "Initial task");
      const ctx = context(testHarness.root, async () => {
        await approvedState(testHarness.root, "replacement-plan", "Replacement task");
        return true;
      });
      await testHarness.commands.get("plan")?.("new planning task", ctx);
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(calls).toBe(0);
      expect(state?.id).toBe("replacement-plan");
      expect(testHarness.reports.at(-1)?.body).toContain("rerun");
      expect(testHarness.reports.at(-1)?.body).toContain("reconfirm");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("start-work mismatch after lease leaves the replacement state untouched and launches no child", async () => {
    let calls = 0;
    const testHarness = await harness(
      async (agent) => { calls++; return agentResult(agent); },
      { beforeLeaseWork: async (root) => approvedState(root, "replacement-plan", "Replacement task") },
    );
    try {
      await approvedState(testHarness.root, "confirmed-plan", "Confirmed task");
      await testHarness.commands.get("start-work")?.("", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(calls).toBe(0);
      expect(state?.id).toBe("replacement-plan");
      expect(testHarness.reports.at(-1)?.body).toContain("rerun");
      expect(testHarness.reports.at(-1)?.body).toContain("reconfirm");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("autopilot mismatch after lease leaves the replacement state untouched and launches no child", async () => {
    let calls = 0;
    const testHarness = await harness(
      async (agent) => { calls++; return agentResult(agent); },
      { beforeLeaseWork: async (root) => approvedState(root, "replacement-plan", "Replacement task") },
    );
    try {
      await approvedState(testHarness.root, "confirmed-plan", "Confirmed task");
      await testHarness.commands.get("autopilot")?.("new autonomous task", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(calls).toBe(0);
      expect(state?.id).toBe("replacement-plan");
      expect(testHarness.reports.at(-1)?.body).toContain("rerun");
      expect(testHarness.reports.at(-1)?.body).toContain("reconfirm");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });
});

describe("writer lease entrypoint coverage", () => {
  test("blocks start-work before Execution Manager or Implementer launch", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => { calls++; return agentResult(agent); }, { blockLease: true });
    try {
      await approvedState(testHarness.root);
      await testHarness.commands.get("start-work")?.("", context(testHarness.root));
      expect(calls).toBe(0);
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench"))))?.status).toBe("approved");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("blocks autopilot and both write-capable delegation interfaces before spawn", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => { calls++; return agentResult(agent); }, { blockLease: true });
    try {
      const ctx = context(testHarness.root);
      await testHarness.commands.get("autopilot")?.("implement it", ctx);
      await testHarness.commands.get("delegate")?.("implementer implement it", ctx);
      await expect(testHarness.tools.get("delegate_task").execute("call", { agent: "implementer", task: "implement it" }, new AbortController().signal, undefined, ctx)).rejects.toBeInstanceOf(ExclusiveLeaseError);
      expect(calls).toBe(0);
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("covers every mutation entrypoint with an allowlisted operation", async () => {
    const workflowSource = await fs.readFile(new URL("../workflow.ts", import.meta.url), "utf8");
    const councilSource = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
    for (const operation of ["start-work", "autopilot", "delegate-task", "delegate-command"]) {
      expect(workflowSource).toContain(`withLease(project.root, \"${operation}\"`);
    }
    const councilImplementation = councilSource.slice(councilSource.indexOf('pi.registerCommand("council-implement"'));
    expect(councilImplementation).toContain('acquireExclusiveLease(root, "council-implement")');
    expect(councilImplementation.indexOf('acquireExclusiveLease(root, "council-implement")')).toBeLessThan(councilImplementation.indexOf("await supervisor.start()"));
    expect(councilImplementation.indexOf('acquireExclusiveLease(root, "council-implement")')).toBeLessThan(councilImplementation.indexOf('id: "integration-implementer"'));
  });
});
