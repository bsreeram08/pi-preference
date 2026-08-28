import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { categoricalAgentTitle, CmuxAgentTabViewer, createCmuxAgentTabViewer } from "../agent-cmux-viewer.ts";
import type { CmuxCommandResult } from "../cmux-workbench.ts";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for cmux viewer state.");
}

describe("cmux agent tab viewer", () => {
  test("opens one unfocused browser tab in the caller pane and keeps command metadata categorical", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cmux-viewer-"));
    const viewerFile = path.join(root, "agent-view.html");
    const commands: string[][] = [];
    const secret = "secret prompt and output sentinel";
    const runner = async (args: readonly string[]): Promise<CmuxCommandResult> => {
      commands.push([...args]);
      if (args[0] === "identify") return {
        ok: true,
        stdout: JSON.stringify({ caller: { workspace_ref: "workspace:21", pane_ref: "pane:53" } }),
        stderr: "",
      };
      if (args[0] === "new-surface") return { ok: true, stdout: "OK surface:97 pane:53 workspace:21\n", stderr: "" };
      return { ok: true, stdout: "OK\n", stderr: "" };
    };
    try {
      const viewer = new CmuxAgentTabViewer(runner);
      viewer.start({
        runId: "run-one",
        agentId: "researcher",
        viewerFile,
        projectName: "pi-workbench",
        status: "starting",
        model: "openai-codex/gpt-5.6-terra:medium",
      });
      viewer.update({ runId: "run-one", status: "running", output: `<unsafe>${secret}</unsafe>`, turns: 2, tools: 4 });
      await waitFor(() => commands.some(([name]) => name === "rename-tab") && fs.access(viewerFile).then(() => true, () => false));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(commands).toContainEqual([
        "new-surface", "--type", "browser", "--pane", "pane:53", "--workspace", "workspace:21",
        "--url", `file://${viewerFile}`, "--focus", "false",
      ]);
      expect(commands).toContainEqual([
        "rename-tab", "--workspace", "workspace:21", "--surface", "surface:97", "--title", "Researcher · working",
      ]);
      expect(JSON.stringify(commands)).not.toContain(secret);

      const html = await fs.readFile(viewerFile, "utf8");
      expect(html).toContain("&lt;unsafe&gt;secret prompt and output sentinel&lt;/unsafe&gt;");
      expect(html).toContain("refreshes every second");
      expect((await fs.lstat(viewerFile)).mode & 0o077).toBe(0);

      viewer.focus("run-one");
      await waitFor(() => commands.some(([name]) => name === "move-surface"));
      expect(commands).toContainEqual([
        "move-surface", "--surface", "surface:97", "--pane", "pane:53", "--workspace", "workspace:21", "--focus", "true",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("uses only allowlisted categorical titles for cmux commands", () => {
    expect(categoricalAgentTitle("researcher")).toBe("Researcher");
    expect(categoricalAgentTitle("dynamic-secret-user-text")).toBe("Specialist");
    expect(categoricalAgentTitle("unknown-project-agent")).toBe("Specialist");
    expect(categoricalAgentTitle("constructor")).toBe("Specialist");
    expect(categoricalAgentTitle("toString")).toBe("Specialist");
    expect(categoricalAgentTitle("__proto__")).toBe("Specialist");
  });

  test("fails soft outside a cmux terminal", () => {
    expect(createCmuxAgentTabViewer({})).toBeUndefined();
  });
});
