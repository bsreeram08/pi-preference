import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CmuxTaskBridge,
  cmuxTitle,
  createCmuxCommandRunner,
  registerCmuxWorkbench,
} from "../cmux-workbench.ts";
import {
  createWorkflowLifecycleEvent,
  decodeWorkflowLifecycleEvent,
  WORKFLOW_LIFECYCLE_EVENT,
} from "../workflow-lifecycle.ts";

const ROOT = path.resolve(import.meta.dir, "..");

describe("cmux workbench bridge", () => {
  test.skipIf(process.platform === "win32")("loads from a fresh installer symlink layout", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-workbench-load-"));
    const agentDir = path.join(directory, "agent");
    const extensionsDir = path.join(agentDir, "extensions");
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.symlink(ROOT, path.join(extensionsDir, "pi-workbench"), "dir");
    await fs.symlink(
      path.join(ROOT, "setup", "cmux-workbench.ts"),
      path.join(extensionsDir, "cmux-workbench.ts"),
      "file",
    );

    try {
      const child = Bun.spawn(["pi"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}\n${stderr}`;
      expect(output).not.toContain("Failed to load extension");
      expect(exitCode).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("accepts only the versioned categorical lifecycle contract", () => {
    const event = createWorkflowLifecycleEvent("execution", "running");
    expect(decodeWorkflowLifecycleEvent(event)).toEqual(event);
    expect(cmuxTitle(event)).toBe("Workflow execution · working");
    expect(decodeWorkflowLifecycleEvent({ ...event, detail: "not allowed" })).toBeUndefined();
    expect(decodeWorkflowLifecycleEvent({ ...event, phase: "custom" })).toBeUndefined();
    expect(decodeWorkflowLifecycleEvent({ ...event, errorCode: "raw failure" })).toBeUndefined();
    expect(decodeWorkflowLifecycleEvent({ ...event, packet: "packet-sentinel" })).toBeUndefined();
    expect(decodeWorkflowLifecycleEvent({ ...event, evidence: "evidence-sentinel" })).toBeUndefined();
  });

  test("targets the explicit workspace and surface with fixed metadata", async () => {
    const commands: string[][] = [];
    const bridge = new CmuxTaskBridge(
      { workspaceId: "workspace:7", surfaceId: "surface:3" },
      async (args) => { commands.push([...args]); return true; },
    );
    const running = createWorkflowLifecycleEvent("planning", "running");
    bridge.transition(running);
    bridge.activity();
    bridge.transition(createWorkflowLifecycleEvent("planning", "completed"), true);
    bridge.clear();
    await bridge.flush();

    expect(commands).toContainEqual([
      "rename-tab", "--workspace", "workspace:7", "--surface", "surface:3", "--title", "Workflow planning · working",
    ]);
    expect(commands).toContainEqual([
      "workspace-action", "--workspace", "workspace:7", "--action", "set-description", "--description", "Workflow planning: working",
    ]);
    expect(commands).toContainEqual([
      "set-progress", "0.55", "--label", "Pi · working", "--workspace", "workspace:7",
    ]);
    expect(commands).toContainEqual([
      "notify", "--title", "Workflow planning", "--subtitle", "done", "--body", "Workflow planning: done", "--workspace", "workspace:7", "--surface", "surface:3",
    ]);
    expect(commands).toContainEqual(["clear-progress", "--workspace", "workspace:7"]);
  });

  test("never forwards sentinel secrets from prompt or extension event payloads", async () => {
    const secret = "SENTINEL-WORKFLOW-SECRET-9f31";
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

    await handlers.get("before_agent_start")?.[0]?.({ prompt: secret, task: secret }, ctx);
    await handlers.get("tool_execution_start")?.[0]?.({ toolName: secret }, ctx);
    bus.get("subagent:control-event")?.[0]?.({
      event: { type: "needs_attention", runId: "run-1", index: 0, reason: "tool_failures", message: secret, recentFailureSummary: secret, label: secret, name: secret },
      noticeText: secret,
    });
    bus.get("subagent:async-complete")?.[0]?.({ source: "async", runId: "run-2", state: "failed", success: false, summary: secret, name: secret, error: secret });
    bus.get("pi-background-tasks:terminal:v1")?.[0]?.({
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { id: "background-1", status: "failed", error: secret, detail: secret, summary: secret, name: secret },
    });
    bus.get(WORKFLOW_LIFECYCLE_EVENT)?.[0]?.({
      ...createWorkflowLifecycleEvent("execution", "failed", "operational_failure"),
      detail: secret,
      task: secret,
      summary: secret,
      packet: `<workflow-task-packet>${secret}</workflow-task-packet>`,
      evidence: `<workflow-verification>${secret}</workflow-verification>`,
    });
    bus.get(WORKFLOW_LIFECYCLE_EVENT)?.[0]?.(createWorkflowLifecycleEvent("execution", "completed"));
    await handlers.get("agent_settled")?.[0]?.({}, ctx);
    await bridge.flush();

    const observableCmuxData = [...commands.flat(), ...titles].join("\n");
    expect(observableCmuxData).not.toContain(secret);
    expect(commands.some(([command]) => command === "notify")).toBe(true);
    expect(commands.some((args) => args.includes("Workflow execution: done"))).toBe(true);
  });

  test("deduplicates one supervisor request but keeps distinct requests actionable", async () => {
    const bus = new Map<string, Array<(payload: unknown) => unknown>>();
    const commands: string[][] = [];
    const pi = {
      on() {},
      events: { on(name: string, handler: (payload: unknown) => unknown) { bus.set(name, [...(bus.get(name) ?? []), handler]); } },
    } as any;
    const bridge = registerCmuxWorkbench(pi, {
      environment: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" },
      runner: async (args) => { commands.push([...args]); return true; },
    });

    bus.get("subagent:control-event")?.[0]?.({ event: { type: "needs_attention", runId: "run-1", index: 0, reason: "supervisor_request" } });
    const first = { requestId: "request-1", runId: "run-1", childIndex: 0 };
    bus.get("pi-intercom:detach-request")?.[0]?.(first);
    bus.get("pi-intercom:detach-request")?.[0]?.(first);
    bus.get("pi-intercom:detach-request")?.[0]?.({ ...first, requestId: "request-2" });
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

  test("fails soft when cmux targeting or executable is unavailable", async () => {
    const commands: string[][] = [];
    const bridge = new CmuxTaskBridge({}, async (args) => { commands.push([...args]); return false; });
    bridge.transition(createWorkflowLifecycleEvent("session", "running"));
    bridge.activity();
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
