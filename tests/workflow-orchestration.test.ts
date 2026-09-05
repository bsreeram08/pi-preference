import { describe, expect, test } from "bun:test";
import { observedChecks } from "./fixtures/check-evidence.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchDashboardController } from "../dashboard-controller.ts";
import { ExclusiveLeaseError } from "../exclusive-lease.ts";
import { registerWorkflow } from "../workflow.ts";
import { getWorkflowPaths, loadCurrentWorkflowPlan, saveWorkflowPlan, type WorkflowPlanState } from "../workflow-state.ts";
import { bindWorkflowTaskPacket, canonicalWorkflowTaskPacketMarker, type WorkflowTaskPacket, type WorkflowTaskPacketDeclaration } from "../workflow-task-packet.ts";
import type { AgentResult, AgentSpec, Exec } from "../types.ts";

interface Harness {
  readonly root: string;
  readonly commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  readonly tools: Map<string, any>;
  readonly reports: Array<{ title: string; body: string }>;
  readonly dashboard: WorkbenchDashboardController;
  readonly leaseOperations: string[];
}

async function harness(
  runAgent: (agent: AgentSpec, call: number, task: string) => Promise<AgentResult>,
  options: { abortOnBegin?: boolean; blockLease?: boolean; beforeLeaseWork?: (root: string) => Promise<void> } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-orchestration-"));
  await fs.mkdir(path.join(root, ".pi", "pi-workbench"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi", "pi-workbench", "config.json"), '{"workflowMode":"thorough"}');
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
  const leaseOperations: string[] = [];
  const exec: Exec = async () => ({ stdout: `${root}\n`, stderr: "", code: 0 });
  registerWorkflow(pi, {
    exec,
    dashboard,
    reprompterPath: path.join(root, "SKILL.md"),
    report(title, body) { reports.push({ title, body }); },
    getRoutingState: () => ({ policy: "balanced" }),
    runAgent: async (_projectRoot, agent, _systemPrompt, task) => runAgent(agent, ++calls, task),
    withLease: async (_projectRoot: string, operation: string, work: () => Promise<unknown>) => {
      leaseOperations.push(operation);
      if (options.blockLease) throw new ExclusiveLeaseError("writer_live", "live");
      await options.beforeLeaseWork?.(root);
      return work();
    },
  });
  return { root, commands, tools, reports, dashboard, leaseOperations };
}

function context(
  root: string,
  confirm: () => Promise<boolean> = async () => true,
  editor: (title: string, initial: string) => Promise<string | undefined> = async () => "approved input",
): any {
  return {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: { confirm, editor, notify() {}, setStatus() {} },
  };
}

function agentResult(agent: AgentSpec, output = "valid output", overrides: Partial<AgentResult> = {}): AgentResult {
  return { agentId: agent.id, title: agent.title, output, exitCode: 0, ...overrides };
}

const PACKET_DECLARATION: WorkflowTaskPacketDeclaration = {
  schemaVersion: 1,
  scope: ["Implement packet-aware workflow completion."],
  nonGoals: ["Do not execute packet-authored commands."],
  acceptanceCriteria: [{ id: "workflow-complete", description: "The approved behavior is implemented and tested.", requiredEvidenceKinds: ["automated-test"] }],
};

function packetPlan(): string {
  return `# Plan\n\nImplement.\n\n${canonicalWorkflowTaskPacketMarker(PACKET_DECLARATION)}`;
}

function packetVerification(packet: WorkflowTaskPacket, overrides: Record<string, unknown> = {}): string {
  const value = {
    schemaVersion: 1,
    packetId: packet.packetId,
    planDigest: packet.planDigest,
    criteria: [{ criterionId: "workflow-complete", status: "passed", evidence: [{ kind: "automated-test", summary: "Focused workflow tests passed." }] }],
    ...overrides,
  };
  return `<workflow-verification>${JSON.stringify(value)}</workflow-verification>`;
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

async function approvedPacketState(root: string, id = "approved-packet-plan"): Promise<WorkflowTaskPacket> {
  const plan = packetPlan();
  const packet = bindWorkflowTaskPacket(plan);
  const state: WorkflowPlanState = {
    version: 1,
    id,
    task: "Implement packet-aware workflow completion",
    status: "approved",
    plan,
    verificationMode: "packet",
    packet,
    interviewNotes: "",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    reviewRounds: 1,
    planPath: "",
  };
  const stateDir = path.join(root, ".pi", "pi-workbench");
  await saveWorkflowPlan(getWorkflowPaths(stateDir), state);
  await fs.writeFile(path.join(stateDir, "config.json"), '{"workflowMaxFixLoops":0}\n', "utf8");
  return packet;
}

function executionResult(agent: AgentSpec, task: string, verifierOutput: string): AgentResult {
  if (agent.id === "execution-manager") return agentResult(agent, "## Blockers\nNone");
  if (agent.id === "implementer") return agentResult(agent, "Implementation complete.");
  if (task.includes("independent completion gate")) return agentResult(agent, verifierOutput, { verification: observedChecks() });
  return agentResult(agent, "<code-verdict>PASS</code-verdict>");
}

describe("workflow orchestration fail-closed behavior", () => {
  test("focused execution uses one implementer, one independent reviewer and an evidence gate", async () => {
    let packet: WorkflowTaskPacket;
    const roles: string[] = [];
    const item = await harness(async (agent, _call, task) => {
      roles.push(agent.id);
      return executionResult(agent, task, packetVerification(packet));
    });
    try {
      packet = await approvedPacketState(item.root, "focused-mode");
      await item.commands.get("start-work")?.("", context(item.root));
      expect(roles).toEqual(["implementer", "technical-reviewer", "quality-reviewer"]);
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(item.root, ".pi", "pi-workbench"))))?.status).toBe("verified");
    } finally { await fs.rm(item.root, { recursive: true, force: true }); }
  });
  test("a verifier's fabricated passing packet without native check receipts blocks completion", async () => {
    let packet: WorkflowTaskPacket;
    const item = await harness(async (agent, _call, task) => {
      const result = executionResult(agent, task, packetVerification(packet));
      delete result.verification;
      return result;
    });
    try {
      packet = await approvedPacketState(item.root, "missing-host-checks");
      await item.commands.get("start-work")?.("", context(item.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(item.root, ".pi", "pi-workbench")));
      expect(state?.status).toBe("blocked");
      expect(state?.execution?.packetVerification).toMatchObject({ protocolFailure: "missing-host-evidence" });
    } finally { await fs.rm(item.root, { recursive: true, force: true }); }
  });
  test("blocks delegate_task before project discovery when project resources are not trusted", async () => {
    let launched = false;
    const item = await harness(async (agent) => {
      launched = true;
      return agentResult(agent);
    });
    const notices: string[] = [];
    const expected = "This project is not trusted. Project .pi resources and packages are ignored. Use /trust to save a trust decision, then restart pi.";
    const result = await item.tools.get("delegate_task").execute(
      "call",
      { agent: "codebase-explorer", task: "Inspect the repository." },
      undefined,
      undefined,
      {
        cwd: item.root,
        hasUI: true,
        isProjectTrusted: () => false,
        ui: { notify(message: string) { notices.push(message); } },
      },
    );
    expect(result.content[0]?.text).toBe(expected);
    expect(result.details.blocked).toBe(expected);
    expect(notices).toEqual([expected]);
    expect(launched).toBe(false);
  });

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
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(state?.status).toBe("cancelled");
      expect(state?.verificationMode).toBe("packet");
      expect(state?.packet).toBeUndefined();
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

describe("workflow task packet command seams", () => {
  function planningResult(agent: AgentSpec, task: string, planned = packetPlan()): AgentResult {
    if (task.includes("Assess whether this task is clear enough")) {
      return agentResult(agent, '<clearance>{"ready":true,"questions":[],"assumptions":[]}</clearance>');
    }
    if (task.includes("Create a decision-complete implementation plan") || task.includes("Revise the plan")) return agentResult(agent, planned);
    if (task.includes("Review this implementation plan")) return agentResult(agent, "<plan-verdict>OKAY</plan-verdict>");
    return agentResult(agent, "Repository evidence.");
  }

  test("/plan persists a packet only when the independently reviewed plan is approved", async () => {
    for (const approve of [false, true]) {
      const testHarness = await harness(async (agent, _call, task) => planningResult(agent, task));
      let confirmations = 0;
      try {
        const ctx = context(
          testHarness.root,
          async () => ++confirmations === 1 ? true : approve,
          async (_title, initial) => initial,
        );
        await testHarness.commands.get("plan")?.("packet task", ctx);
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        expect(state?.status).toBe(approve ? "approved" : "draft");
        expect(state?.packet === undefined).toBe(!approve);
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    }
  });

  test("/plan parses a malformed initial packet before launching any reviewer", async () => {
    const malformed = "# Plan\n\nNo terminal packet.";
    let reviewerCalls = 0;
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Review this implementation plan")) reviewerCalls += 1;
      return planningResult(agent, task, malformed);
    });
    try {
      await testHarness.commands.get("plan")?.("packet task", context(testHarness.root, async () => true, async (_title, initial) => initial));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(reviewerCalls).toBe(0);
      expect(state?.status).toBe("blocked");
      expect(state?.packet).toBeUndefined();
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/plan reparses and independently re-reviews user edits before binding", async () => {
    const editedDeclaration = { ...PACKET_DECLARATION, scope: ["Implement the user-edited packet scope."] };
    const editedPlan = `# Plan\n\nEdited.\n\n${canonicalWorkflowTaskPacketMarker(editedDeclaration)}`;
    let reviewCalls = 0;
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Review this implementation plan")) reviewCalls += 1;
      return planningResult(agent, task);
    });
    try {
      await testHarness.commands.get("plan")?.("packet task", context(testHarness.root, async () => true, async () => editedPlan));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(reviewCalls).toBe(4);
      expect(state?.status).toBe("approved");
      expect(state?.packet).toEqual(bindWorkflowTaskPacket(editedPlan));
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/plan parses an edited packet before launching reviewers for that edit", async () => {
    let malformedEditReviewerCalls = 0;
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Review this implementation plan") && task.includes("Packet removed.")) malformedEditReviewerCalls += 1;
      return planningResult(agent, task);
    });
    try {
      await testHarness.commands.get("plan")?.("packet task", context(testHarness.root, async () => true, async () => "# Plan\n\nPacket removed."));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(malformedEditReviewerCalls).toBe(0);
      expect(state?.status).toBe("draft");
      expect(state?.packet).toBeUndefined();
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/start-work preserves packet authority when execution is cancelled", async () => {
    const testHarness = await harness(async (agent) => agentResult(agent, "cancelled", { cancelled: true }));
    try {
      const packet = await approvedPacketState(testHarness.root, "packet-cancelled-execution");
      await testHarness.commands.get("start-work")?.("", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(state?.status).toBe("cancelled");
      expect(state?.verificationMode).toBe("packet");
      expect(state?.packet).toEqual(packet);
      expect(state?.execution?.completedAt).toBeDefined();
      expect(state?.execution?.verificationPassed).toBe(false);
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/start-work rejects legacy verification for packet plans and accepts exact packet evidence", async () => {
    for (const [verifier, expected] of [["<verified/>", "blocked"], ["packet", "verified"]] as const) {
      let packet!: WorkflowTaskPacket;
      const testHarness = await harness(async (agent, _call, task) => executionResult(agent, task, verifier === "packet" ? packetVerification(packet) : verifier));
      try {
        packet = await approvedPacketState(testHarness.root, `packet-${expected}`);
        await testHarness.commands.get("start-work")?.("", context(testHarness.root));
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        expect(state?.status).toBe(expected);
        if (expected === "verified") expect(state?.execution?.packetVerification?.result).toBe("passed");
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    }
  });

  test("/start-work fail-closes wrong binding, unknown, missing, duplicate, wrong-kind, failed, and skipped packet evidence", async () => {
    const variants: Array<(packet: WorkflowTaskPacket) => string> = [
      (packet) => packetVerification(packet, { packetId: `wtp-${"0".repeat(32)}` }),
      (packet) => packetVerification(packet, { unknown: true }),
      (packet) => packetVerification(packet, { criteria: [] }),
      (packet) => packetVerification(packet, { criteria: [
        { criterionId: "workflow-complete", status: "passed", evidence: [{ kind: "automated-test", summary: "Passed." }] },
        { criterionId: "workflow-complete", status: "passed", evidence: [{ kind: "automated-test", summary: "Passed." }] },
      ] }),
      (packet) => packetVerification(packet, { criteria: [{ criterionId: "workflow-complete", status: "passed", evidence: [{ kind: "build", summary: "Built." }] }] }),
      (packet) => packetVerification(packet, { criteria: [{ criterionId: "workflow-complete", status: "failed", evidence: [{ kind: "automated-test", summary: "Failed." }] }] }),
      (packet) => packetVerification(packet, { criteria: [{ criterionId: "workflow-complete", status: "skipped", evidence: [] }] }),
    ];
    for (let index = 0; index < variants.length; index++) {
      let packet!: WorkflowTaskPacket;
      const testHarness = await harness(async (agent, _call, task) => executionResult(agent, task, variants[index](packet)));
      try {
        packet = await approvedPacketState(testHarness.root, `packet-failure-${index}`);
        await testHarness.commands.get("start-work")?.("", context(testHarness.root));
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        expect(state?.status).toBe("blocked");
        expect(state?.execution?.verificationPassed).toBe(false);
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    }
  });

  test("packet fix prompts receive concise structured failures and never raw verifier output", async () => {
    let packet!: WorkflowTaskPacket;
    let fixPrompt = "";
    const failedOutput = () => packetVerification(packet, { criteria: [{ criterionId: "workflow-complete", status: "failed", evidence: [{ kind: "automated-test", summary: "VERIFIER-SUMMARY-SENTINEL" }] }] });
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.startsWith("Fix the current implementation")) fixPrompt = task;
      return executionResult(agent, task, failedOutput());
    });
    try {
      packet = await approvedPacketState(testHarness.root, "packet-fix-prompt");
      await fs.writeFile(path.join(testHarness.root, ".pi", "pi-workbench", "config.json"), '{"workflowMaxFixLoops":1}\n', "utf8");
      await testHarness.commands.get("start-work")?.("", context(testHarness.root));
      expect(fixPrompt).toContain("- workflow-complete: failed.");
      expect(fixPrompt).not.toContain("VERIFIER-SUMMARY-SENTINEL");
      expect(fixPrompt).toContain(packet.packetId);
      expect(fixPrompt).not.toContain("<workflow-verification>");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/autopilot binds only after dual plan review", async () => {
    const packet = bindWorkflowTaskPacket(packetPlan());
    let reviewSawPacket = false;
    let executionSawPacket = false;
    let testHarness!: Harness;
    testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Review this implementation plan")) {
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        reviewSawPacket ||= state?.packet !== undefined;
      }
      if (agent.id === "execution-manager") executionSawPacket = task.includes(packet.packetId);
      if (task.includes("Assess whether this task is clear enough")
        || task.includes("Create a decision-complete implementation plan")
        || task.includes("Review this implementation plan")
        || task.includes("mandatory pre-plan gap analysis")
        || task.includes("Map the repository")) return planningResult(agent, task);
      return executionResult(agent, task, packetVerification(packet));
    });
    try {
      await testHarness.commands.get("autopilot")?.("packet task", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(reviewSawPacket).toBe(false);
      expect(executionSawPacket).toBe(true);
      expect(state?.status).toBe("verified");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/autopilot blocks a malformed planner revision", async () => {
    let revisionReturned = false;
    let reviewRound = 0;
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Revise the plan")) {
        revisionReturned = true;
        return agentResult(agent, "# Plan\n\nMalformed revision without packet.");
      }
      if (task.includes("Review this implementation plan")) {
        reviewRound += 1;
        return agentResult(agent, reviewRound <= 2 ? "<plan-verdict>REJECT</plan-verdict>" : "<plan-verdict>OKAY</plan-verdict>");
      }
      return planningResult(agent, task);
    });
    try {
      await testHarness.commands.get("autopilot")?.("packet task", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
      expect(revisionReturned).toBe(true);
      expect(reviewRound).toBe(2);
      expect(state?.status).toBe("blocked");
      expect(state?.packet).toBeUndefined();
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  test("/autopilot stops at the configured fix-loop cap after failed packet verification", async () => {
    const packet = bindWorkflowTaskPacket(packetPlan());
    let verifierCalls = 0;
    const testHarness = await harness(async (agent, _call, task) => {
      if (task.includes("Assess whether this task is clear enough")
        || task.includes("Create a decision-complete implementation plan")
        || task.includes("Review this implementation plan")
        || task.includes("mandatory pre-plan gap analysis")
        || task.includes("Map the repository")) return planningResult(agent, task);
      if (task.includes("independent completion gate")) verifierCalls += 1;
      const failed = packetVerification(packet, { criteria: [{ criterionId: "workflow-complete", status: "failed", evidence: [{ kind: "automated-test", summary: "Focused test failed." }] }] });
      return executionResult(agent, task, failed);
    });
    try {
      const stateDir = path.join(testHarness.root, ".pi", "pi-workbench");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, "config.json"), '{"workflowMaxFixLoops":0}\n', "utf8");
      await testHarness.commands.get("autopilot")?.("packet task", context(testHarness.root));
      const state = await loadCurrentWorkflowPlan(getWorkflowPaths(stateDir));
      expect(verifierCalls).toBe(1);
      expect(state?.status).toBe("blocked");
      expect(state?.execution?.packetVerification?.result).toBe("failed");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    { name: "cancellation", result: (agent: AgentSpec) => agentResult(agent, "cancelled", { cancelled: true }), status: "cancelled" },
    { name: "interruption", result: (agent: AgentSpec) => agentResult(agent, "failed", { exitCode: 1 }), status: "interrupted" },
  ]) {
    test(`/start-work preserves packet and verifier evidence on fixer ${scenario.name}`, async () => {
      let packet!: WorkflowTaskPacket;
      const evidenceSentinel = `PERSISTED-${scenario.name.toUpperCase()}-EVIDENCE`;
      const failedVerification = () => packetVerification(packet, {
        criteria: [{ criterionId: "workflow-complete", status: "failed", evidence: [{ kind: "automated-test", summary: evidenceSentinel }] }],
      });
      const testHarness = await harness(async (agent, _call, task) => {
        if (task.startsWith("Fix the current implementation")) return scenario.result(agent);
        return executionResult(agent, task, failedVerification());
      });
      try {
        packet = await approvedPacketState(testHarness.root, `packet-${scenario.status}`);
        await fs.writeFile(path.join(testHarness.root, ".pi", "pi-workbench", "config.json"), '{"workflowMaxFixLoops":1}\n', "utf8");
        await testHarness.commands.get("start-work")?.("", context(testHarness.root));
        const state = await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")));
        expect(state?.status).toBe(scenario.status);
        expect(state?.verificationMode).toBe("packet");
        expect(state?.packet).toEqual(packet);
        expect(JSON.stringify(state?.execution?.packetVerification)).toContain(evidenceSentinel);
      } finally {
        await fs.rm(testHarness.root, { recursive: true, force: true });
      }
    });
  }

  test("/start-work persists passing structured evidence and digest without the raw envelope", async () => {
    let packet!: WorkflowTaskPacket;
    const packetHarness = await harness(async (agent, _call, task) => executionResult(agent, task, packetVerification(packet)));
    try {
      packet = await approvedPacketState(packetHarness.root, "packet-concise");
      await packetHarness.commands.get("start-work")?.("", context(packetHarness.root));
      const current = await fs.readFile(path.join(packetHarness.root, ".pi", "pi-workbench", "workflow", "current.json"), "utf8");
      expect(current).toContain("Focused workflow tests passed.");
      expect(current).toContain("verifierOutputDigest");
      expect(current).not.toContain("<workflow-verification>");
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(packetHarness.root, ".pi", "pi-workbench"))))?.status).toBe("verified");
    } finally {
      await fs.rm(packetHarness.root, { recursive: true, force: true });
    }
  });

  test("/start-work rejects verifier outer prose without persisting it", async () => {
    const rawSentinel = "RAW-COMMAND-OUTPUT-SENTINEL";
    let packet!: WorkflowTaskPacket;
    const packetHarness = await harness(async (agent, _call, task) => executionResult(agent, task, `${packetVerification(packet)}\n${rawSentinel}`));
    try {
      packet = await approvedPacketState(packetHarness.root, "packet-outer-prose");
      await packetHarness.commands.get("start-work")?.("", context(packetHarness.root));
      const current = await fs.readFile(path.join(packetHarness.root, ".pi", "pi-workbench", "workflow", "current.json"), "utf8");
      expect(current).not.toContain(rawSentinel);
      expect(current).toContain('"protocolFailure": "malformed-envelope"');
    } finally {
      await fs.rm(packetHarness.root, { recursive: true, force: true });
    }
  });

  test("packetless legacy verification still succeeds", async () => {
    const legacyHarness = await harness(async (agent, _call, task) => executionResult(agent, task, "commands ran\n<verified/>"));
    try {
      await approvedState(legacyHarness.root, "legacy-verified");
      await legacyHarness.commands.get("start-work")?.("", context(legacyHarness.root));
      expect((await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(legacyHarness.root, ".pi", "pi-workbench"))))?.status).toBe("verified");
    } finally {
      await fs.rm(legacyHarness.root, { recursive: true, force: true });
    }
  });
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
  test("blocks plan before discovery and records the plan writer operation", async () => {
    let calls = 0;
    const testHarness = await harness(async (agent) => { calls++; return agentResult(agent); }, { blockLease: true });
    try {
      await testHarness.commands.get("plan")?.("plan safely", context(testHarness.root));
      expect(calls).toBe(0);
      expect(testHarness.leaseOperations).toEqual(["plan"]);
      expect(await loadCurrentWorkflowPlan(getWorkflowPaths(path.join(testHarness.root, ".pi", "pi-workbench")))).toBeUndefined();
      expect(testHarness.reports.at(-1)?.title).toBe("Workflow writer unavailable");
    } finally {
      await fs.rm(testHarness.root, { recursive: true, force: true });
    }
  });

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
    for (const operation of ["plan", "start-work", "autopilot", "delegate-task", "delegate-command"]) {
      expect(workflowSource).toContain(`withLease(project.root, \"${operation}\"`);
    }
    const councilImplementation = councilSource.slice(councilSource.indexOf('pi.registerCommand("council-implement"'));
    expect(councilImplementation).toContain('acquireExclusiveLease(root, "council-implement")');
    expect(councilImplementation.indexOf('acquireExclusiveLease(root, "council-implement")')).toBeLessThan(councilImplementation.indexOf("await supervisor.start()"));
    expect(councilImplementation.indexOf('acquireExclusiveLease(root, "council-implement")')).toBeLessThan(councilImplementation.indexOf('id: "integration-implementer"'));
  });
});
