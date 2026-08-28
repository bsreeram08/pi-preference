import { describe, expect, test } from "bun:test";
import { authenticatedHello, JsonlDecoder, launcherText, runCmuxCommand, surfaceListed } from "../agent-cmux-bridge.mjs";

describe("trusted cmux stdio/control bridge", () => {
  test("requires the exact run-bound channel token", () => {
    const contract = { runId: "run-one", authToken: "a".repeat(64) };
    expect(authenticatedHello({ type: "hello", version: 1, runId: "run-one", token: "a".repeat(64) }, contract)).toBe(true);
    expect(authenticatedHello({ type: "hello", version: 1, runId: "run-one", token: "b".repeat(64) }, contract)).toBe(false);
    expect(authenticatedHello({ type: "hello", version: 1, runId: "other", token: "a".repeat(64) }, contract)).toBe(false);
  });

  test("rejects oversized authenticated-channel frames", () => {
    const decoder = new JsonlDecoder(32);
    expect(decoder.push('{"type":"hello"}\n')).toEqual([{ type: "hello" }]);
    expect(new JsonlDecoder(8).push("{}\n{}\n{}\n")).toEqual([{}, {}, {}]);
    expect(() => decoder.push("x".repeat(33))).toThrow("frame_too_large");
  });

  test("escalates a timed-out cmux subprocess that ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await runCmuxCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], 50);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("checks exact pane membership instead of cmux identify fallback", () => {
    const listed = "* surface:91  Main [selected]\n  surface:123  Planner · running\n";
    expect(surfaceListed(listed, "surface:123")).toBe(true);
    expect(surfaceListed(listed, "surface:12")).toBe(false);
    expect(surfaceListed(listed, "surface:999")).toBe(false);
  });

  test("keeps task text out of launcher arguments while retaining exact private Pi configuration", () => {
    const text = launcherText({
      projectRoot: "/private/project", socketPath: "/private/run/control.sock", authToken: "a".repeat(64),
      piCommand: "/usr/bin/pi", piArgs: ["--session-dir", "/private/run/sessions", "--extension", "/trusted/child.ts"],
      childEnvironment: { HOME: "/private/run/home", PATH: "/usr/bin" },
    });
    expect(text).toContain("exec env -i");
    expect(text).toContain("PI_WORKBENCH_BRIDGE_TOKEN");
    expect(text).not.toContain("--mode");
    expect(text).not.toContain("prompt sentinel");
  });
});
