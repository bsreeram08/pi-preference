import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROJECT_TRUST_REQUIRED_MESSAGE = "This project is not trusted. Project .pi resources and packages are ignored. Use /trust to save a trust decision, then restart pi.";

type ProjectTrustContext = Pick<ExtensionContext, "hasUI" | "isProjectTrusted" | "ui">;

/**
 * Fail closed before a Workbench child can inherit an incomplete project loadout.
 * Returns the user-facing message so every launch interface can stop without
 * creating a child process.
 */
export function guardSubagentLaunch(ctx: ProjectTrustContext): string | undefined {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted();
  } catch {
    // Missing or failed trust resolution is not safe enough for child launch.
  }
  if (trusted) return undefined;
  if (ctx.hasUI) ctx.ui.notify(PROJECT_TRUST_REQUIRED_MESSAGE, "warning");
  return PROJECT_TRUST_REQUIRED_MESSAGE;
}
