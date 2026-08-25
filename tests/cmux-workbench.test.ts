import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CmuxTaskBridge,
  cmuxTitle,
  createCmuxCommandRunner,
  registerCmuxWorkbench,
  sanitizeCmuxText,
} from "../setup/cmux-workbench.ts";

describe("cmux workbench bridge", () => {
  test("normalizes and bounds task titles", () => {
    expect(sanitizeCmuxText("  Configure\nPi\u0000 models  ", 40)).toBe("Configure Pi models");
    expect(sanitizeCmuxText("x".repeat(20), 8)).toBe("xxxxxxx…");
    expect(cmuxTitle("Configure Pi", "running")).toBe("Configure Pi · working");
  });

  test("targets the active workspace and surface across stable cmux surfaces", async () => {
    const commands: string[][] = [];
    const bridge = new CmuxTaskBridge(
      { workspaceId: "workspace:7", surfaceId: "surface:3" },
      async (args) => { commands.push([...args]); return true; },
    );

    bridge.transition({ task: "Configure Pi", state: "running", detail: "Starting" });
    bridge.activity("Pi · testing");
    bridge.transition({ task: "Configure Pi", state: "completed", detail: "Verified", notify: true });
    bridge.clear();
    await bridge.flush();

    expect(commands).toContainEqual([
      "rename-tab", "--workspace", "workspace:7", "--surface", "surface:3", "--title", "Configure Pi · working",
    ]);
    expect(commands).toContainEqual([
      "workspace-action", "--workspace", "workspace:7", "--action", "set-description", "--description", "Pi working: Configure Pi — Starting",
    ]);
    expect(commands).toContainEqual([
      "set-status", "pi_workbench", "working", "--icon", "sparkle", "--color", "#FF8A4C", "--workspace", "workspace:7",
    ]);
    expect(commands).toContainEqual([
      "set-progress", "0.55", "--label", "Pi · testing", "--workspace", "workspace:7",
    ]);
    expect(commands).toContainEqual([
      "notify", "--title", "Pi done", "--subtitle", "Configure Pi", "--body", "Verified", "--workspace", "workspace:7", "--surface", "surface:3",
    ]);
    expect(commands).toContainEqual(["clear-progress", "--workspace", "workspace:7"]);
    expect(commands).toContainEqual(["clear-status", "pi_workbench", "--workspace", "workspace:7"]);
  });

  test("notifies attention and command completion without routine child-completion noise", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const bus = new Map<string, Array<(payload: unknown) => unknown>>();
    const commands: string[][] = [];
    const titles: string[] = [];
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      events: {
        on(name: string, handler: (payload: unknown) => unknown) {
          bus.set(name, [...(bus.get(name) ?? []), handler]);
        },
      },
    } as any;
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      ui: { setTitle(value: string) { titles.push(value); } },
    };
    const bridge = registerCmuxWorkbench(pi, {
      environment: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" },
      runner: async (args) => { commands.push([...args]); return true; },
    });

    await handlers.get("before_agent_start")?.[0]?.({ prompt: "Review routing\ncarefully" }, ctx);
    await handlers.get("tool_execution_start")?.[0]?.({ toolName: "read" }, ctx);
    await handlers.get("agent_end")?.[0]?.({}, ctx);
    await handlers.get("agent_settled")?.[0]?.({}, ctx);

    const attention = {
      type: "needs_attention",
      runId: "run-1",
      index: 0,
      reason: "supervisor_request",
      label: "Review routing",
      message: "Choose the release branch",
    };
    bus.get("subagent:control-event")?.[0]?.({ event: attention, source: "async", noticeText: attention.message });
    bus.get("subagent:control-event")?.[0]?.({ event: attention, source: "async", noticeText: attention.message });
    bus.get("subagent:async-complete")?.[0]?.({ source: "async", runId: "run-2", state: "complete", success: true, summary: "Review done" });
    bus.get("subagent:async-complete")?.[0]?.({ source: "async", runId: "run-2", state: "complete", success: true, summary: "Review done" });
    bus.get("pi-workbench:task-state:v1")?.[0]?.({
      schemaVersion: 1,
      taskId: "workflow-1",
      state: "completed",
      title: "Apply plan",
      detail: "Verified",
      terminal: true,
      progress: { value: 1, label: "Done" },
    });
    await bridge.flush();

    const notifications = commands.filter(([name]) => name === "notify");
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toContain("Pi needs attention");
    expect(notifications[1]).toContain("Pi done");
    expect(titles).toEqual(["Review routing carefully · working", "Review routing carefully · done"]);
  });

  test("keeps distinct supervisor requests actionable while deduplicating one request", async () => {
    const bus = new Map<string, Array<(payload: unknown) => unknown>>();
    const commands: string[][] = [];
    const pi = {
      on() {},
      events: {
        on(name: string, handler: (payload: unknown) => unknown) {
          bus.set(name, [...(bus.get(name) ?? []), handler]);
        },
      },
    } as any;
    const bridge = registerCmuxWorkbench(pi, {
      environment: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" },
      runner: async (args) => { commands.push([...args]); return true; },
    });

    const first = { requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 0 };
    const second = { requestId: "request-2", runId: "run-1", agent: "worker", childIndex: 0 };
    bus.get("subagent:control-event")?.[0]?.({
      event: { type: "needs_attention", runId: "run-1", index: 0, reason: "supervisor_request", message: "Waiting for supervisor" },
      source: "async",
    });
    bus.get("pi-intercom:detach-request")?.[0]?.(first);
    bus.get("pi-intercom:detach-request")?.[0]?.(first);
    bus.get("pi-intercom:detach-request")?.[0]?.(second);
    await bridge.flush();

    expect(commands.filter(([name]) => name === "notify")).toHaveLength(2);
  });

  test("does not coalesce tool-failure attention with a later supervisor request", async () => {
    const bus = new Map<string, Array<(payload: unknown) => unknown>>();
    const commands: string[][] = [];
    const pi = {
      on() {},
      events: {
        on(name: string, handler: (payload: unknown) => unknown) {
          bus.set(name, [...(bus.get(name) ?? []), handler]);
        },
      },
    } as any;
    const bridge = registerCmuxWorkbench(pi, {
      environment: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" },
      runner: async (args) => { commands.push([...args]); return true; },
    });

    bus.get("subagent:control-event")?.[0]?.({
      event: { type: "needs_attention", runId: "run-1", index: 0, reason: "tool_failures", message: "Repeated tool failures" },
      source: "foreground",
    });
    bus.get("pi-intercom:detach-request")?.[0]?.({
      requestId: "request-1",
      runId: "run-1",
      agent: "worker",
      childIndex: 0,
    });
    await bridge.flush();

    expect(commands.filter(([name]) => name === "notify")).toHaveLength(2);
  });

  test.skipIf(process.platform === "win32")("escalates a timed-out cmux process from TERM to KILL", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-workbench-timeout-"));
    const executable = path.join(directory, "hung-cmux");
    const pidFile = path.join(directory, "pid");
    await fs.writeFile(executable, [
      "#!/bin/sh",
      "printf '%s' \"$$\" > \"$1\"",
      "trap '' TERM",
      "while :; do :; done",
    ].join("\n"));
    await fs.chmod(executable, 0o755);
    try {
      const runner = createCmuxCommandRunner(
        { ...process.env, CMUX_BUNDLED_CLI_PATH: executable },
        { timeoutMs: 2_000, killGraceMs: 100 },
      );
      const started = Date.now();
      expect(await runner([pidFile])).toBe(false);
      expect(Date.now() - started).toBeLessThan(3_000);
      const pid = Number(await fs.readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("fails soft when cmux session targeting or executable is unavailable", async () => {
    const commands: string[][] = [];
    const bridge = new CmuxTaskBridge({}, async (args) => { commands.push([...args]); return false; });
    bridge.transition({ task: "No cmux", state: "running" });
    bridge.activity("working");
    bridge.clear();
    await bridge.flush();
    expect(commands).toEqual([]);

    const missing = createCmuxCommandRunner(
      { ...process.env, CMUX_BUNDLED_CLI_PATH: path.join(os.tmpdir(), "missing-cmux-executable") },
      { timeoutMs: 20, killGraceMs: 20 },
    );
    expect(await missing(["ping"])).toBe(false);
  });
});
