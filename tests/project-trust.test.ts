import { describe, expect, test } from "bun:test";
import { guardSubagentLaunch, PROJECT_TRUST_REQUIRED_MESSAGE } from "../project-trust.ts";
import { registerWorkbenchResearch } from "../research.ts";

function untrustedContext(notices: string[] = []): any {
  return {
    cwd: "/untrusted-project",
    hasUI: true,
    isProjectTrusted: () => false,
    ui: { notify(message: string) { notices.push(message); } },
  };
}

describe("subagent project trust gate", () => {
  test("fails closed with one actionable message", () => {
    const notices: string[] = [];
    expect(guardSubagentLaunch(untrustedContext(notices))).toBe(PROJECT_TRUST_REQUIRED_MESSAGE);
    expect(notices).toEqual([PROJECT_TRUST_REQUIRED_MESSAGE]);
  });

  test("allows trusted projects without UI noise", () => {
    const notices: string[] = [];
    expect(guardSubagentLaunch({
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify(message: string) { notices.push(message); } },
    } as any)).toBeUndefined();
    expect(notices).toEqual([]);
  });

  test("blocks deep research before project discovery or child launch", async () => {
    const tools = new Map<string, any>();
    let discovered = false;
    registerWorkbenchResearch({
      on() {},
      registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    } as any, {
      exec: async () => {
        discovered = true;
        throw new Error("project discovery must not run");
      },
      dashboard: {} as any,
      report() {},
    });
    const notices: string[] = [];
    const result = await tools.get("deep_research").execute(
      "call",
      { question: "What changed?", decision: "Choose an approach" },
      undefined,
      undefined,
      untrustedContext(notices),
    );
    expect(result.content[0]?.text).toBe(PROJECT_TRUST_REQUIRED_MESSAGE);
    expect(notices).toEqual([PROJECT_TRUST_REQUIRED_MESSAGE]);
    expect(discovered).toBe(false);
  });
});
