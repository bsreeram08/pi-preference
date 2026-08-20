import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 10_000;
const NETWORK_RETRY_DELAY_MS = 200;
const GENERIC_COMMAND_ERROR = "Could not load coding-plan usage. Check your connection or run /login, then try again.";

interface JsonObject {
  [key: string]: unknown;
}

interface UsageWindow {
  group: string;
  allowed: boolean | undefined;
  limitReached: boolean | undefined;
  usedPercent: number;
  remainingPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAtSeconds: number;
}

export interface CodingPlanUsage {
  provider: string;
  planType: string;
  allowed: boolean | undefined;
  limitReached: boolean | undefined;
  windows: UsageWindow[];
}

export interface UsageRequest {
  baseUrl: string;
  token: string;
  accountId: string;
  headers?: Record<string, string | null | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type UsageReporter = (title: string, body: string) => void;

class SafeUsageError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentage(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseWindow(
  value: unknown,
  group: string,
  allowed: boolean | undefined,
  limitReached: boolean | undefined,
): UsageWindow | undefined {
  if (!isObject(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  const windowSeconds = finiteNumber(value.limit_window_seconds);
  const resetAfterSeconds = finiteNumber(value.reset_after_seconds);
  const resetAtSeconds = finiteNumber(value.reset_at);
  if (
    usedPercent === undefined
    || windowSeconds === undefined
    || resetAfterSeconds === undefined
    || resetAtSeconds === undefined
  ) {
    return undefined;
  }
  const used = percentage(usedPercent);
  return {
    group,
    allowed,
    limitReached,
    usedPercent: used,
    remainingPercent: 100 - used,
    windowSeconds: Math.max(0, Math.round(windowSeconds)),
    resetAfterSeconds: Math.max(0, Math.round(resetAfterSeconds)),
    resetAtSeconds: Math.max(0, Math.round(resetAtSeconds)),
  };
}

function addRateLimitWindows(windows: UsageWindow[], value: unknown, group: string): void {
  if (!isObject(value)) return;
  const allowed = typeof value.allowed === "boolean" ? value.allowed : undefined;
  const limitReached = typeof value.limit_reached === "boolean" ? value.limit_reached : undefined;
  const primary = parseWindow(value.primary_window, group, allowed, limitReached);
  const secondary = parseWindow(value.secondary_window, group, allowed, limitReached);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
}

export function parseOpenAiCodexUsage(payload: unknown): CodingPlanUsage {
  if (!isObject(payload) || typeof payload.plan_type !== "string" || !payload.plan_type.trim()) {
    throw new SafeUsageError("OpenAI Codex returned an invalid usage response.");
  }
  const windows: UsageWindow[] = [];
  addRateLimitWindows(windows, payload.rate_limit, "Coding plan");

  if (Array.isArray(payload.additional_rate_limits)) {
    for (const value of payload.additional_rate_limits) {
      if (!isObject(value)) continue;
      const name = typeof value.limit_name === "string" && value.limit_name.trim()
        ? value.limit_name.trim()
        : "Additional limit";
      addRateLimitWindows(windows, value.rate_limit, name);
    }
  }

  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : undefined;
  return {
    provider: "OpenAI Codex",
    planType: payload.plan_type.trim(),
    allowed: typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined,
    limitReached: typeof rateLimit?.limit_reached === "boolean" ? rateLimit.limit_reached : undefined,
    windows,
  };
}

export function extractChatGptAccountId(token: string): string {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) throw new Error("invalid token");
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!isObject(payload)) throw new Error("invalid payload");
    const auth = payload[OPENAI_AUTH_CLAIM];
    if (!isObject(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) {
      throw new Error("missing account id");
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new SafeUsageError("OpenAI Codex authentication is missing its account identifier. Run /login again.");
  }
}

function usageEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.includes("/backend-api")
    ? `${normalized}/wham/usage`
    : `${normalized}/api/codex/usage`;
}

function requestError(error: unknown, timeoutSignal: AbortSignal, callerSignal?: AbortSignal): SafeUsageError {
  if (timeoutSignal.aborted) return new SafeUsageError("OpenAI Codex usage request timed out.");
  if (callerSignal?.aborted) return new SafeUsageError("OpenAI Codex usage request was cancelled.");
  return new SafeUsageError("Could not reach the OpenAI Codex usage service.");
}

export async function fetchOpenAiCodexUsage(request: UsageRequest): Promise<CodingPlanUsage> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${request.token}`);
  headers.set("ChatGPT-Account-Id", request.accountId);
  headers.set("Accept", "application/json");

  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await (request.fetch ?? globalThis.fetch)(usageEndpoint(request.baseUrl), {
        method: "GET",
        headers,
        signal,
      });
      break;
    } catch (error) {
      if (attempt === 1 || signal.aborted) throw requestError(error, timeoutSignal, request.signal);
      try {
        await delay(request.retryDelayMs ?? NETWORK_RETRY_DELAY_MS, undefined, { signal });
      } catch (delayError) {
        throw requestError(delayError, timeoutSignal, request.signal);
      }
    }
  }

  if (!response) throw new SafeUsageError("Could not reach the OpenAI Codex usage service.");
  if (!response.ok) {
    throw new SafeUsageError(`OpenAI Codex usage request failed (${response.status}). Run /login if the session expired.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal.aborted) throw requestError(error, timeoutSignal, request.signal);
    throw new SafeUsageError("OpenAI Codex returned an invalid usage response.");
  }
  return parseOpenAiCodexUsage(payload);
}

function titleCasePlan(planType: string): string {
  const known: Record<string, string> = {
    prolite: "Pro Lite",
    free_workspace: "Free Workspace",
    self_serve_business_prolite: "Business Pro Lite",
    self_serve_business_usage_based: "Business Usage Based",
  };
  return known[planType] ?? (
    planType
      .replace(/[\r\n]+/g, " ")
      .split("_")
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ") || "Unknown"
  );
}

function windowLabel(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}-day window`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}-hour window`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}-minute window`;
  return "Usage window";
}

function relativeReset(resetAtMs: number, nowMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil((resetAtMs - nowMs) / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `in ${totalHours}h${minutes ? ` ${minutes}m` : ""}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `in ${days}d${hours ? ` ${hours}h` : ""}`;
}

function resetDescription(window: UsageWindow, nowMs: number): string {
  const resetAtMs = window.resetAtSeconds > 0
    ? window.resetAtSeconds * 1000
    : nowMs + window.resetAfterSeconds * 1000;
  const localTime = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAtMs));
  return `${relativeReset(resetAtMs, nowMs)} · ${localTime}`;
}

function statusLabel(allowed: boolean | undefined, limitReached: boolean | undefined): string {
  if (limitReached === true || allowed === false) return "Limit reached";
  if (allowed === true && limitReached === false) return "Available";
  return "Unknown";
}

function markdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/([*_`])/g, "\\$1")
    .trim();
}

function markdownCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|");
}

export function formatCodingPlanUsage(usage: CodingPlanUsage, nowMs = Date.now()): string {
  const lines = [
    `**Provider:** ${markdownText(usage.provider)}`,
    `**Plan:** ${markdownText(titleCasePlan(usage.planType))}`,
    `**Coding-plan status:** ${statusLabel(usage.allowed, usage.limitReached)}`,
    "",
  ];

  if (usage.windows.length === 0) {
    lines.push("No usage-window details were returned by the provider.");
    return lines.join("\n");
  }

  lines.push("| Limit | Status | Remaining | Used | Resets |", "|---|---|---:|---:|---|");
  for (const window of usage.windows) {
    const label = window.group === "Coding plan"
      ? windowLabel(window.windowSeconds)
      : `${window.group} · ${windowLabel(window.windowSeconds)}`;
    lines.push(
      `| ${markdownCell(label)} | ${statusLabel(window.allowed, window.limitReached)} | **${window.remainingPercent}%** | ${window.usedPercent}% | ${resetDescription(window, nowMs)} |`,
    );
  }
  lines.push("", "Provider quota is fetched only when `/usage` is run; credentials are never displayed or stored by Workbench.");
  return lines.join("\n");
}

export function usageCommandErrorMessage(error: unknown): string {
  return error instanceof SafeUsageError ? error.message : GENERIC_COMMAND_ERROR;
}

export function registerUsageCommand(pi: ExtensionAPI, report: UsageReporter): void {
  pi.registerCommand("usage", {
    description: "Show remaining usage and reset times for the active coding plan",
    handler: async (_args, ctx) => {
      const providerId = ctx.model?.provider;
      if (!providerId) {
        ctx.ui.notify("No active model is selected.", "warning");
        return;
      }
      if (providerId !== OPENAI_CODEX_PROVIDER) {
        const provider = ctx.modelRegistry.getProviderDisplayName(providerId);
        report("Coding plan usage", `Usage lookup is not yet supported for **${markdownText(provider)}**.`);
        return;
      }

      try {
        const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
        const token = resolved?.auth.apiKey;
        if (!token) {
          ctx.ui.notify("OpenAI Codex is not authenticated. Run /login first.", "warning");
          return;
        }
        const accountId = extractChatGptAccountId(token);
        const baseUrl = resolved.auth.baseUrl ?? ctx.model?.baseUrl ?? "https://chatgpt.com/backend-api";
        const usage = await fetchOpenAiCodexUsage({
          baseUrl,
          token,
          accountId,
          headers: resolved.auth.headers,
        });
        report("Coding plan usage", formatCodingPlanUsage(usage));
      } catch (error) {
        ctx.ui.notify(usageCommandErrorMessage(error), "error");
      }
    },
  });
}
