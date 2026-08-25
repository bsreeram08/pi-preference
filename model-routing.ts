import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  BALANCED_ROUTES,
  BALANCED_ROUTING_STATE,
  formatRoutingReceipt,
  nativeSubagentFallback,
  normalizeRoutingPolicy,
  parseFixedRoutingModel,
  parseSessionRoutingDirective,
  type ModelRoutingState,
} from "./routing.ts";

export const MODEL_ROUTING_ENTRY = "pi-workbench-model-routing";
export const MODEL_ROUTING_RECEIPT_ENTRY = "pi-workbench-model-routing-receipt";

interface StoredRoutingState {
  version: 1;
  state: ModelRoutingState;
}

export interface ModelRoutingController {
  getState(): ModelRoutingState;
  status(): string;
}

function cloneState(state: ModelRoutingState): ModelRoutingState {
  return state.fixed ? { policy: state.policy, fixed: { ...state.fixed } } : { policy: state.policy };
}

export function restoreModelRoutingState(value: unknown): ModelRoutingState {
  if (!value || typeof value !== "object") return { ...BALANCED_ROUTING_STATE };
  const stored = value as Partial<StoredRoutingState>;
  if (stored.version !== 1 || !stored.state || typeof stored.state !== "object") return { ...BALANCED_ROUTING_STATE };
  if (stored.state.policy === "fixed" && stored.state.fixed && typeof stored.state.fixed.model === "string") {
    const parsed = parseFixedRoutingModel(stored.state.fixed.model);
    if (parsed && parsed.model === stored.state.fixed.model && parsed.thinking === stored.state.fixed.thinking) {
      return { policy: "fixed", fixed: parsed };
    }
  }
  return { policy: normalizeRoutingPolicy(stored.state.policy) };
}

function projectRoutingPolicy(cwd: string): Exclude<ModelRoutingState["policy"], "fixed"> {
  let current = path.resolve(cwd);
  for (;;) {
    const configPath = path.join(current, ".pi", "pi-workbench", "config.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { modelRoutingPolicy?: unknown };
      return normalizeRoutingPolicy(parsed.modelRoutingPolicy);
    } catch {
      // Walk toward the project root; a missing or malformed routing field fails to balanced.
    }
    const parent = path.dirname(current);
    if (parent === current) return "balanced";
    current = parent;
  }
}

function fixedRouteIsAvailable(ctx: ExtensionContext, state: ModelRoutingState): boolean {
  if (state.policy !== "fixed" || !state.fixed) return true;
  const bareModel = state.fixed.model.replace(/:(?:low|medium|high)$/, "");
  const slash = bareModel.indexOf("/");
  if (slash <= 0) return false;
  const provider = bareModel.slice(0, slash);
  const modelId = bareModel.slice(slash + 1);
  if (provider !== "openai-codex" || !modelId) return false;
  try {
    return Boolean(ctx.modelRegistry.find(provider, modelId));
  } catch {
    return false;
  }
}

function stateLabel(state: ModelRoutingState): string {
  if (state.policy !== "fixed" || !state.fixed) return state.policy;
  const shortModel = state.fixed.model.replace(/^openai-codex\//, "");
  return `fixed:${shortModel}`;
}

function stateDescription(state: ModelRoutingState): string {
  if (state.policy === "fixed" && state.fixed) {
    return `Fixed child route for this session: \`${state.fixed.model}\` (${state.fixed.thinking}). Main Pi keeps its current model; the session override changes delegated children only. To override the parent temporarily, launch it with \`pi --model ${state.fixed.model.replace(/:(?:low|medium|high)$/, "")} --thinking ${state.fixed.thinking}\`.`;
  }
  return `${state.policy[0].toUpperCase()}${state.policy.slice(1)} adaptive routing is active. New sessions use the durable project policy (balanced by default).`;
}

function nativeRoutingGuidance(state: ModelRoutingState): string {
  const fixed = state.policy === "fixed" && state.fixed
    ? ` Fixed mode is active: use ${state.fixed.model} with ${state.fixed.thinking} thinking as every workflow default unless the user explicitly changes the session route. Main Pi keeps its current model; fixed mode changes delegated children only.`
    : "";
  return `Adaptive delegation routing: before every pi-subagents runs.run/runs.all launch, classify each lane independently from complexity, uncertainty, risk, breadth, and verification cost; role is only a prior. Set each lane's model with its thinking suffix explicitly (for example, :low/:medium/:high). Balanced routes are light=${BALANCED_ROUTES.light.model}, standard=${BALANCED_ROUTES.standard.model}, heavy=${BALANCED_ROUTES.heavy.model}. A hard scout/recon lane can and should reach Sol; never use Spark for image/visual work. Before launch, show one compact line with role, model/thinking, reason, and read-only budget. For read-only lanes use 8 turns/30 tools (light), 16/60 (standard), or 30/120 (heavy), with stop-and-synthesize guidance. Put turnBudget/toolBudget at workflow defaults only when all children share that read-only budget; otherwise keep differently budgeted lanes in separate calls and set per-child toolBudget where supported. Never hard-cap mutation-capable workers.${fixed}`;
}

export function registerModelRouting(
  pi: ExtensionAPI,
  report?: (title: string, body: string) => void,
): ModelRoutingController {
  let state: ModelRoutingState = { ...BALANCED_ROUTING_STATE };
  let durablePolicy: Exclude<ModelRoutingState["policy"], "fixed"> = "balanced";

  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setStatus("model-routing", `route:${stateLabel(state)}`);
  };

  const appendReceipt = (content: string): void => {
    pi.appendEntry(MODEL_ROUTING_RECEIPT_ENTRY, { content });
  };

  pi.registerEntryRenderer(MODEL_ROUTING_RECEIPT_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { content?: unknown };
    const content = typeof data.content === "string" ? data.content : "Model routing updated.";
    return new Text(theme.fg("muted", content), 0, 0);
  });

  const applyState = (ctx: ExtensionContext, next: ModelRoutingState, persist: boolean): void => {
    state = cloneState(next);
    if (persist) pi.appendEntry<StoredRoutingState>(MODEL_ROUTING_ENTRY, { version: 1, state });
    updateStatus(ctx);
  };

  const showState = (ctx: ExtensionContext): void => {
    const body = `${stateDescription(state)}\n\n- \`balanced\`: Luna/low for light work, Terra/medium for standard work, and Sol/high for heavy work\n- \`economy\`: Luna for light work, Spark for standard work, and Terra for heavy work\n- \`quality\`: Terra for light work and Sol/high for standard or heavy work\n- \`fixed <model-or-alias>\`: session-only fixed child route (\`spark\`, \`luna\`, \`terra\`, \`sol\`, or an available \`openai-codex/<model>[:thinking]\`); Main Pi keeps its current model\n- \`reset\`: restore the durable project route (${durablePolicy}) for this session`;
    if (report) report("Model routing", body);
    else if (ctx.hasUI) ctx.ui.notify(body, "info");
  };

  pi.registerCommand("model-routing", {
    description: "Show or set session-only adaptive model routing: balanced, economy, quality, fixed, or reset",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      if (!args || args === "status") {
        showState(ctx);
        return;
      }
      const normalized = args.toLowerCase();
      if (normalized === "balanced" || normalized === "economy" || normalized === "quality" || normalized === "reset") {
        applyState(ctx, { policy: normalized === "reset" ? durablePolicy : normalized }, true);
        showState(ctx);
        return;
      }
      const fixed = args.match(/^fixed\s+(.+)$/i)?.[1]?.trim();
      if (!fixed) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /model-routing [status|balanced|economy|quality|fixed <spark|luna|terra|sol|openai-codex/model[:low|medium|high]>|reset]", "warning");
        return;
      }
      const route = parseFixedRoutingModel(fixed);
      if (!route) {
        if (ctx.hasUI) ctx.ui.notify("Fixed routes must be a known alias or openai-codex/<model>[:low|medium|high].", "warning");
        return;
      }
      const next = { policy: "fixed", fixed: route } as const;
      if (!fixedRouteIsAvailable(ctx, next)) {
        if (ctx.hasUI) ctx.ui.notify(`Model ${route.model.replace(/:(?:low|medium|high)$/, "")} is not available in Pi's OpenAI Codex registry.`, "warning");
        return;
      }
      applyState(ctx, next, true);
      showState(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    durablePolicy = projectRoutingPolicy(ctx.cwd);
    state = { policy: durablePolicy };
    const entry = ctx.sessionManager.getBranch()
      .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === MODEL_ROUTING_ENTRY)
      .pop() as { data?: unknown } | undefined;
    if (entry) {
      const restored = restoreModelRoutingState(entry.data);
      if (fixedRouteIsAvailable(ctx, restored)) state = restored;
      else if (ctx.hasUI) ctx.ui.notify("The saved fixed child route is no longer available; restored the durable adaptive policy.", "warning");
    }
    updateStatus(ctx);
  });

  pi.on("input", async (event, ctx) => {
    const directive = parseSessionRoutingDirective(event.text);
    if (!directive) return { action: "continue" as const };
    if (!fixedRouteIsAvailable(ctx, directive)) {
      if (ctx.hasUI) ctx.ui.notify("That fixed OpenAI Codex route is not available in this Pi installation.", "warning");
      return { action: "handled" as const };
    }
    applyState(ctx, directive, true);
    appendReceipt(stateDescription(state));
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${nativeRoutingGuidance(state)}`,
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent" || event.input.action !== undefined) return;
    const fallback = nativeSubagentFallback(event.input, state);
    for (const [key, value] of Object.entries(fallback.input)) event.input[key] = value;
    const role = typeof event.input.agent === "string" ? event.input.agent : "workflow";
    appendReceipt(formatRoutingReceipt(role, fallback.route));
  });

  return {
    getState: () => cloneState(state),
    status: () => stateLabel(state),
  };
}
