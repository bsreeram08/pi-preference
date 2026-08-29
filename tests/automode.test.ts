import { describe, expect, test } from "bun:test";
import { AUTOMODE_GUIDANCE, AUTOMODE_RELOAD_ENTRY, registerAutomode } from "../automode.ts";

interface AutomodeHarness {
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  reports: Array<{ title: string; body: string }>;
  statuses: Array<string | undefined>;
  notifications: Array<{ message: string; level: string | undefined }>;
  entries: Array<{ type: "custom"; customType: string; data: unknown }>;
  setIdle(value: boolean): void;
  ctx: any;
}

function createHarness(initialEntries: AutomodeHarness["entries"] = []): AutomodeHarness {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const reports: Array<{ title: string; body: string }> = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const entries = initialEntries.map((entry) => ({ ...entry }));
  let idle = true;
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as any;
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      notify(message: string, level?: string) { notifications.push({ message, level }); },
    },
  };
  registerAutomode(pi, (title, body) => reports.push({ title, body }));
  return {
    commands,
    handlers,
    reports,
    statuses,
    notifications,
    entries,
    setIdle(value: boolean) { idle = value; },
    ctx,
  };
}

describe("session automode", () => {
  test("is off by default and reports session-only status", async () => {
    const harness = createHarness();
    await harness.handlers.get("session_start")?.[0]?.({ reason: "startup" }, harness.ctx);
    await harness.commands.get("automode")?.("status", harness.ctx);

    expect(harness.reports.at(-1)).toEqual({
      title: "Automode",
      body: "Automode is **off**. Pi may ask normal clarification questions. Enable it for this session with `/automode on`.",
    });
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(harness.entries).toEqual([]);
  });

  test("injects scoped conservative guidance only while enabled", async () => {
    const harness = createHarness();
    const beforeAgentStart = harness.handlers.get("before_agent_start")?.[0];
    expect(await beforeAgentStart?.({ systemPrompt: "base prompt" }, harness.ctx)).toBeUndefined();

    await harness.commands.get("automode")?.("on", harness.ctx);
    const injected = await beforeAgentStart?.({ systemPrompt: "base prompt" }, harness.ctx) as { systemPrompt: string };

    expect(harness.statuses.at(-1)).toBe("automode:on");
    expect(injected.systemPrompt).toStartWith("base prompt\n\n");
    expect(injected.systemPrompt).toContain(AUTOMODE_GUIDANCE);
    expect(injected.systemPrompt).toContain("never expands the user's requested task, scope, or write authority");
    expect(injected.systemPrompt).toContain("read-only requests remain non-mutating");
    expect(injected.systemPrompt).toContain("Do not ask routine clarification questions");
    expect(injected.systemPrompt).toContain("credentials or secrets");
    expect(injected.systemPrompt).toContain("destructive, high-risk, or irreversible");
    expect(injected.systemPrompt).toContain("ambiguity is truly unrecoverable");
    expect(injected.systemPrompt).toContain("Never bypass native approvals");

    await harness.commands.get("automode")?.("off", harness.ctx);
    expect(await beforeAgentStart?.({ systemPrompt: "base prompt" }, harness.ctx)).toBeUndefined();
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(harness.entries).toEqual([]);
  });

  test("rejects both state changes while an agent run is active", async () => {
    const harness = createHarness();
    const beforeAgentStart = harness.handlers.get("before_agent_start")?.[0];
    harness.setIdle(false);
    await harness.commands.get("automode")?.("on", harness.ctx);

    expect(await beforeAgentStart?.({ systemPrompt: "base prompt" }, harness.ctx)).toBeUndefined();
    expect(harness.reports.at(-1)).toEqual({
      title: "Automode unchanged",
      body: "Automode can change only while Pi is idle. Stop or wait for the current work to settle, then retry.",
    });

    harness.setIdle(true);
    await harness.commands.get("automode")?.("on", harness.ctx);
    harness.setIdle(false);
    await harness.commands.get("automode")?.("off", harness.ctx);

    expect(await beforeAgentStart?.({ systemPrompt: "base prompt" }, harness.ctx)).toMatchObject({
      systemPrompt: expect.stringContaining(AUTOMODE_GUIDANCE),
    });
    expect(harness.statuses.at(-1)).toBe("automode:on");
    expect(harness.reports.at(-1)?.title).toBe("Automode unchanged");
  });

  test("survives extension reload but resets on session replacement or process startup", async () => {
    const original = createHarness();
    await original.commands.get("automode")?.("on", original.ctx);
    await original.handlers.get("session_shutdown")?.[0]?.({ reason: "reload" }, original.ctx);
    expect(original.entries).toEqual([{ type: "custom", customType: AUTOMODE_RELOAD_ENTRY, data: { version: 1, enabled: true } }]);

    const reloaded = createHarness(original.entries);
    const beforeAgentStart = reloaded.handlers.get("before_agent_start")?.[0];
    await reloaded.handlers.get("session_start")?.[0]?.({ reason: "reload" }, reloaded.ctx);
    expect(await beforeAgentStart?.({ systemPrompt: "base prompt" }, reloaded.ctx)).toMatchObject({
      systemPrompt: expect.stringContaining(AUTOMODE_GUIDANCE),
    });

    for (const reason of ["new", "resume", "fork", "startup"] as const) {
      const reset = createHarness(original.entries);
      await reset.handlers.get("session_start")?.[0]?.({ reason }, reset.ctx);
      expect(await reset.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base prompt" }, reset.ctx)).toBeUndefined();
    }
  });

  test("rejects unknown actions without changing state", async () => {
    const harness = createHarness();
    await harness.commands.get("automode")?.("forever", harness.ctx);
    expect(harness.reports.at(-1)).toEqual({ title: "Automode", body: "Usage: /automode [on|off|status]" });
    expect(harness.notifications).toEqual([]);
    expect(harness.entries).toEqual([]);
  });
});
