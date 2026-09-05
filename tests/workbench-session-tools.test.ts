import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyTodoAction, restoreTodoSnapshot } from "../workbench-todo.ts";
import { validateAskQuestions } from "../workbench-ask.ts";
import { parseGoal, renderGoal, goalPath, registerWorkbenchGoal } from "../workbench-goal.ts";

describe("workbench todo", () => {
  test("creates, updates, and lists items without cycles", () => {
    let state = restoreTodoSnapshot(undefined);
    const created = applyTodoAction(state, { action: "create", subject: "Diagnose subagent spawn" });
    expect(created.text).toContain("Created #1");
    state = created.snapshot;
    const second = applyTodoAction(state, { action: "create", subject: "Replace todo package", blockedBy: [1] });
    state = second.snapshot;
    const updated = applyTodoAction(state, { action: "update", id: 1, status: "in_progress", activeForm: "diagnosing" });
    expect(updated.text).toContain("in_progress");
    expect(applyTodoAction(updated.snapshot, { action: "list" }).text).toContain("blocked by 1");
    expect(() => applyTodoAction(updated.snapshot, { action: "create", subject: "bad", blockedBy: [99] })).toThrow(/blockedBy/);
  });
});

describe("workbench ask", () => {
  test("rejects reserved labels and empty questionnaires", () => {
    expect(() => validateAskQuestions([])).toThrow(/1-4/);
    expect(() => validateAskQuestions([{
      question: "Which runtime?",
      header: "Runtime",
      options: [{ label: "Other", description: "custom" }, { label: "Node", description: "node" }],
    }])).toThrow(/reserved/);
    expect(validateAskQuestions([{
      question: "Which runtime?",
      header: "Runtime",
      options: [
        { label: "Node", description: "Use Node" },
        { label: "Bun", description: "Use Bun" },
      ],
    }])).toHaveLength(1);
  });
});

describe("workbench goal", () => {
  test("does not inject paused goals as active instructions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-paused-goal-"));
    try {
      let beforeStart: any;
      registerWorkbenchGoal({ on(_event: string, handler: any) { beforeStart = handler; }, registerTool() {}, registerCommand() {} } as any,
        { exec: async () => ({ stdout: root, stderr: "", code: 0 }), report() {} });
      const file = goalPath(path.join(root, ".pi", "pi-workbench"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      const goal = { version: 1, objective: "Paused objective", status: "paused", autoContinue: false, updatedAt: new Date().toISOString() };
      await fs.writeFile(file, JSON.stringify(goal));
      expect(await beforeStart({ systemPrompt: "base" }, { cwd: root })).toBeUndefined();
      await fs.writeFile(file, JSON.stringify({ ...goal, status: "active" }));
      expect((await beforeStart({ systemPrompt: "base" }, { cwd: root })).systemPrompt).toContain("Paused objective");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  test("parses and renders a user-owned goal", async () => {
    expect(parseGoal({})).toBeUndefined();
    const goal = parseGoal({
      version: 1,
      objective: "Cut pi-subagents coupling",
      status: "active",
      autoContinue: false,
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(renderGoal(goal)).toContain("Cut pi-subagents coupling");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-goal-"));
    try {
      expect(goalPath(path.join(root, ".pi", "pi-workbench"))).toBe(path.join(root, ".pi", "pi-workbench", "goal.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
