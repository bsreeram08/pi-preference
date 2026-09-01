import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { casesRoot, inferOutcomeKind, renderCaseL1, WorkbenchCaseStore } from "../cases-store.ts";
import { registerWorkbenchCases } from "../cases.ts";

async function fixture(prefix: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await fs.mkdir(agentDir);
  await fs.mkdir(project);
  return { root, agentDir, project, store: new WorkbenchCaseStore(agentDir, project) };
}

describe("Workbench cases", () => {
  test("stores cases outside the project and recalls newest first", async () => {
    const { root, agentDir, project, store } = await fixture("workbench-cases-");
    try {
      expect(casesRoot(agentDir, project).startsWith(project + path.sep)).toBe(false);
      await store.retain({
        intent: "Ship routing family.",
        action: "Added /model-routing grok --default.",
        outcome: "PR merged.",
      });
      await Bun.sleep(5);
      await store.retain({
        intent: "Interactive explorer tab.",
        action: "Started technical-reviewer.",
        outcome: "Bash-free gate blocked launch.",
        gap: "Persistent read-only Bash profiles were rejected.",
        outcomeKind: "failure",
      });
      const recalled = await store.recall();
      const failed = recalled.find((entry) => entry.outcomeKind === "failure");
      const succeeded = recalled.find((entry) => entry.outcomeKind === "success");
      expect(failed?.gap).toContain("Persistent read-only");
      expect(succeeded?.intent).toContain("Ship routing family");
      expect(recalled.map((entry) => entry.id)).toEqual([failed?.id, succeeded?.id]);
      const l1 = renderCaseL1(recalled);
      expect(l1).toContain("continuity only");
      expect(l1).toContain("failure");
      const files = await fs.readdir(casesRoot(agentDir, project));
      expect(files.every((name) => name.endsWith(".json"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects secrets, missing gaps, and skips corrupt files", async () => {
    const { root, agentDir, project, store } = await fixture("workbench-cases-safety-");
    try {
      await expect(store.retain({
        intent: "Save a token.",
        action: "Wrote it down.",
        outcome: "API key = sk-testfixture-abcdefghijklmnopqrstuvwxyz123456",
      })).rejects.toThrow("credential or secret");
      await expect(store.retain({
        intent: "Fix CI.",
        action: "Reran tests.",
        outcome: "Still failing.",
        outcomeKind: "failure",
      })).rejects.toThrow("gap");
      expect(inferOutcomeKind("done")).toBe("success");
      expect(inferOutcomeKind("could not start", "lease blocked writers")).toBe("blocked");
      const directory = casesRoot(agentDir, project);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "broken.json"), "{not-json", "utf8");
      expect(await store.recall()).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("registers recall/retain tools and a status command without throwing on missing store", async () => {
    const tools: Array<{ name: string }> = [];
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const reports: string[] = [];
    registerWorkbenchCases({
      on() {},
      registerTool(tool: { name: string }) { tools.push(tool); },
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
    } as any, {
      exec: async () => ({ stdout: "/missing-project\n", stderr: "", code: 0 }),
      report: (_title, body) => reports.push(body),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["workbench_cases"]);
    await commands.get("cases")?.("", { cwd: "/missing-project" });
    expect(reports.at(-1)).toContain("No cases yet.");
  });
});
