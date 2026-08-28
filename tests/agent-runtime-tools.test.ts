import { describe, expect, test } from "bun:test";
import { registerAgentRuntimeTools } from "../agent-runtime-tools.ts";
import { getDefaultAgentRunManager, setDefaultAgentRunManager } from "../agent-run-manager.ts";
import { runSingleAgent } from "../subagents.ts";
import { SupervisorClient } from "../supervisor.ts";

describe("first-party agent runtime tool surface", () => {
  test("registers clear functional operations without replacing delegate_task", () => {
    const tools: Array<{ name: string; description?: string }> = [];
    const pi = {
      registerTool(tool: { name: string; description?: string }) { tools.push(tool); },
    };
    registerAgentRuntimeTools(pi as any, {
      manager: {} as any,
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      getRoutingState: () => ({ policy: "balanced" }),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "workbench_agent_start",
      "workbench_agent_message",
      "workbench_agent_status",
      "workbench_agent_answer",
      "workbench_agent_cancel",
      "workbench_agent_focus",
    ]);
    expect(tools.some((tool) => tool.name === "subagent")).toBe(false);
    expect(tools.find((tool) => tool.name === "workbench_agent_start")?.description).toContain("persistent");
  });

  test("rejects persistent Bash-capable profiles before project discovery", async () => {
    const tools: any[] = [];
    registerAgentRuntimeTools({ registerTool(tool: unknown) { tools.push(tool); } } as any, {
      manager: {} as any,
      exec: async () => { throw new Error("project discovery must not run"); },
      getRoutingState: () => ({ policy: "balanced" }),
    });
    const start = tools.find((tool) => tool.name === "workbench_agent_start");
    await expect(start.execute("call", { agent: "codebase-explorer", task: "Inspect." }, undefined, undefined, { cwd: "/missing" }))
      .rejects.toThrow("Bash-free read-only profile");
  });

  test("keeps the legacy launcher seam as a facade over the shared manager", async () => {
    const original = getDefaultAgentRunManager();
    let request: any;
    const fake = {
      async runToResult(value: unknown) {
        request = value;
        return { agentId: "planner", title: "Planner", output: "managed", exitCode: 0 };
      },
    };
    setDefaultAgentRunManager(fake as any);
    try {
      const result = await runSingleAgent(
        "/project",
        { id: "planner", title: "Planner", description: "Plans", triggers: [], readOnly: true },
        "system",
        "task",
      );
      expect(result.output).toBe("managed");
      expect(request).toMatchObject({ projectRoot: "/project", systemPrompt: "system", task: "task" });
    } finally {
      setDefaultAgentRunManager(original);
    }
  });

  test("routes council supervisor decisions through the authoritative manager", async () => {
    let request: any;
    const manager = {
      async start(value: unknown) {
        request = value;
        return {
          runId: "supervisor-run-1",
          completion: Promise.resolve({
            agentId: "council-supervisor",
            title: "Council Supervisor",
            output: '<workbench-decision>{"action":"delegate","phase":"review","roles":["quality-reviewer"],"rationale":"Independent review is required."}</workbench-decision>',
            exitCode: 0,
          }),
        };
      },
      async cancel() {},
    };
    const updates: unknown[] = [];
    const supervisor = new SupervisorClient("/project", { updateJob: (...args: unknown[]) => updates.push(args) } as any, manager as any);
    const decision = await supervisor.decide("Choose the next phase.");
    expect(decision).toMatchObject({ action: "delegate", phase: "review", roles: ["quality-reviewer"] });
    expect(request).toMatchObject({ projectRoot: "/project", agent: { id: "council-supervisor", readOnly: true } });
    expect(updates).toHaveLength(1);
  });
});
