import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AUTOMODE_RELOAD_ENTRY = "pi-workbench-automode-reload";

export const AUTOMODE_GUIDANCE = `## Session automode

Automode is active for this main Coordinator session. It changes clarification policy only; it never expands the user's requested task, scope, or write authority.

- Continue the current task autonomously within its requested scope. Planning, review, research, and other read-only requests remain non-mutating unless the user explicitly asks for implementation.
- Do not ask routine clarification questions or pause merely because several reasonable choices exist.
- Inspect repository and session evidence, choose conservative and reversible defaults, keep applicable implementation and verification moving, and report material assumptions in the final response.
- Ask the user only when safe bounded progress is impossible because credentials or secrets are required, a destructive, high-risk, or irreversible action needs approval, or ambiguity is truly unrecoverable and no conservative reversible path exists.
- Before asking, exhaust safe read-only inspection and any independent work that can still progress.
- Never bypass native approvals, permission gates, writer leases, reviews, tests, or security controls. Automode does not authorize publishing, pushing, deploying, destructive changes, or access to credentials.
- Automode does not start /autopilot and does not change delegated child-agent behavior.`;

interface StoredAutomodeReloadState {
  version: 1;
  enabled: boolean;
}

export interface AutomodeController {
  isEnabled(): boolean;
  status(): "on" | "off";
}

function stateDescription(enabled: boolean): string {
  if (!enabled) {
    return "Automode is **off**. Pi may ask normal clarification questions. Enable it for this session with `/automode on`.";
  }
  return "Automode is **on** for this session. Pi will make conservative, reversible choices and keep building without routine questions. It may still stop for credentials, destructive or high-risk actions, or truly unrecoverable ambiguity. Native approval and safety gates remain active.";
}

export function registerAutomode(
  pi: ExtensionAPI,
  report?: (title: string, body: string) => void,
): AutomodeController {
  let enabled = false;

  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setStatus("automode", enabled ? "automode:on" : undefined);
  };

  const showState = (ctx: ExtensionContext): void => {
    const body = stateDescription(enabled);
    if (report) report("Automode", body);
    else if (ctx.hasUI) ctx.ui.notify(body, "info");
  };

  pi.registerCommand("automode", {
    description: "Control session-only autonomous progress: /automode [on|off|status]",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();
      if (!action || action === "status") {
        showState(ctx);
        return;
      }
      if (action !== "on" && action !== "off") {
        const usage = "Usage: /automode [on|off|status]";
        if (report) report("Automode", usage);
        else if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        return;
      }
      if (!ctx.isIdle()) {
        const body = "Automode can change only while Pi is idle. Stop or wait for the current work to settle, then retry.";
        if (report) report("Automode unchanged", body);
        else if (ctx.hasUI) ctx.ui.notify(body, "warning");
        return;
      }
      enabled = action === "on";
      updateStatus(ctx);
      showState(ctx);
    },
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") {
      pi.appendEntry<StoredAutomodeReloadState>(AUTOMODE_RELOAD_ENTRY, { version: 1, enabled });
    }
  });

  pi.on("session_start", async (event, ctx) => {
    enabled = false;
    if (event.reason === "reload") {
      const entry = ctx.sessionManager.getBranch()
        .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === AUTOMODE_RELOAD_ENTRY)
        .pop() as { data?: Partial<StoredAutomodeReloadState> } | undefined;
      if (entry?.data?.version === 1 && typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
    }
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${AUTOMODE_GUIDANCE}` };
  });

  return {
    isEnabled: () => enabled,
    status: () => enabled ? "on" : "off",
  };
}
