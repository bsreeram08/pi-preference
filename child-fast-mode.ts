import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_ROUTES = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
] as const;

export function supportsFastModeRoute(route: string | undefined): boolean {
  return typeof route === "string" && (FAST_MODE_ROUTES as readonly string[]).includes(route);
}

export function applyPriorityServiceTier(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}

export default function childFastMode(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => applyPriorityServiceTier(event.payload));
}
