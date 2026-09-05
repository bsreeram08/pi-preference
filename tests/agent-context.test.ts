import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentContext } from "../agent-context.ts";
import { routeConcepts } from "../workflow-concepts.ts";
import { routeTask } from "../routing.ts";
import { buildCodeReviewTask } from "../workflow-prompts.ts";

describe("task-specific child context", () => {
  test("supplies project instructions, referenced RTK and selected skill content", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-"));
    try {
      const projectRoot = path.join(base, "project");
      const agentDir = path.join(base, "agent");
      const home = path.join(base, "home");
      await fs.mkdir(projectRoot);
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      await fs.mkdir(path.join(home, ".agents", "skills", "tdd"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "@RTK.md\nPreserve the domain language.");
      await fs.writeFile(path.join(home, ".codex", "RTK.md"), "Prefix shell commands with rtk.");
      await fs.writeFile(path.join(home, ".agents", "skills", "tdd", "SKILL.md"), "Write a failing behavioral test first.");
      const bundle = await buildAgentContext({ projectRoot, agentDir, home, role: "implementer", task: "Fix build" });
      expect(bundle).toContain("Preserve the domain language");
      expect(bundle).toContain("Prefix shell commands with rtk");
      expect(bundle).toContain("Write a failing behavioral test first");
      expect(bundle).toContain("Skills not supplied");
      expect(bundle).not.toContain("emil-design-eng");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  test("does not route ordinary words as UI work or long text as hard work", () => {
    expect(routeConcepts("Fix the build requirements", "implementer").packs).not.toContain("design");
    expect(routeConcepts("Improve UI animation", "implementer").packs).toContain("design");
    const request = { task: "Find README", role: "codebase-explorer", readOnly: true };
    expect(routeTask({ ...request, task: `${request.task}\n${"x".repeat(2000)}` }).effort).toBe(routeTask(request).effort);
  });

  test("independent review does not receive the implementer's self-assessment", () => {
    const prompt = buildCodeReviewTask("quality-reviewer", "task", "plan", "AUTHOR-CERTAINTY-SENTINEL");
    expect(prompt).not.toContain("AUTHOR-CERTAINTY-SENTINEL");
    expect(prompt).toContain("Form your own assessment");
  });
});
