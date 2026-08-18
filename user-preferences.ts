import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface UserPreference {
  id: string;
  statement: string;
  context?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  version: 1;
  preferences: UserPreference[];
}

interface PreferenceToolDetails {
  profile: UserProfile;
  path: string;
  preference?: UserPreference;
  removed?: number;
}

const PROFILE_FILE = path.join(getAgentDir(), "user-profile.json");
const MAX_PREFERENCES = 100;

function emptyProfile(): UserProfile {
  return { version: 1, preferences: [] };
}

function normalizeStatement(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
}

function normalizeProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object") return emptyProfile();
  const raw = value as { preferences?: unknown };
  if (!Array.isArray(raw.preferences)) return emptyProfile();
  const seen = new Set<string>();
  const preferences: UserPreference[] = [];
  for (const candidate of raw.preferences) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Partial<UserPreference>;
    const statement = normalizeStatement(item.statement);
    if (!statement || seen.has(statement.toLowerCase())) continue;
    seen.add(statement.toLowerCase());
    const now = new Date().toISOString();
    preferences.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id : createPreferenceId(statement),
      statement,
      ...(normalizeStatement(item.context) ? { context: normalizeStatement(item.context) } : {}),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
    });
    if (preferences.length >= MAX_PREFERENCES) break;
  }
  return { version: 1, preferences };
}

function createPreferenceId(statement: string): string {
  const slug = statement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "preference";
  return `${slug}-${Date.now().toString(36)}`;
}

export async function loadUserProfile(): Promise<UserProfile> {
  try {
    return normalizeProfile(JSON.parse(await fs.readFile(PROFILE_FILE, "utf8")));
  } catch {
    return emptyProfile();
  }
}

async function writeUserProfile(profile: UserProfile): Promise<UserProfile> {
  const normalized = normalizeProfile(profile);
  await fs.mkdir(path.dirname(PROFILE_FILE), { recursive: true });
  const temporary = `${PROFILE_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, PROFILE_FILE);
  return normalized;
}

export async function saveUserProfile(profile: UserProfile): Promise<UserProfile> {
  return withFileMutationQueue(PROFILE_FILE, () => writeUserProfile(profile));
}

export async function rememberUserPreference(statement: string, context?: string): Promise<UserPreference> {
  const normalizedStatement = normalizeStatement(statement);
  if (!normalizedStatement) throw new Error("A durable preference statement is required.");
  if (/\b(?:api[_ -]?key|password|secret|token|private[_ -]?key)\b\s*(?::|=|is\s+)\S{4,}/i.test(normalizedStatement)) {
    throw new Error("Refusing to store a possible credential or secret in the user profile.");
  }
  return withFileMutationQueue(PROFILE_FILE, async () => {
    const profile = await loadUserProfile();
    const existing = profile.preferences.find((item) => item.statement.toLowerCase() === normalizedStatement.toLowerCase());
    const now = new Date().toISOString();
    if (existing) {
      existing.updatedAt = now;
      const normalizedContext = normalizeStatement(context);
      if (normalizedContext) existing.context = normalizedContext;
      await writeUserProfile(profile);
      return existing;
    }
    const preference: UserPreference = {
      id: createPreferenceId(normalizedStatement),
      statement: normalizedStatement,
      ...(normalizeStatement(context) ? { context: normalizeStatement(context) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    profile.preferences.push(preference);
    if (profile.preferences.length > MAX_PREFERENCES) profile.preferences.splice(0, profile.preferences.length - MAX_PREFERENCES);
    await writeUserProfile(profile);
    return preference;
  });
}

export async function forgetUserPreference(id: string): Promise<{ removed: number; profile: UserProfile }> {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("Preference id is required for forget.");
  return withFileMutationQueue(PROFILE_FILE, async () => {
    const profile = await loadUserProfile();
    const before = profile.preferences.length;
    profile.preferences = profile.preferences.filter((item) => item.id !== normalizedId);
    const saved = await writeUserProfile(profile);
    return { removed: before - saved.preferences.length, profile: saved };
  });
}

export function formatUserProfile(profile: UserProfile): string {
  if (profile.preferences.length === 0) return "(No durable user preferences recorded.)";
  return profile.preferences.map((item) => `- [${item.id}] ${item.statement}${item.context ? ` — ${item.context}` : ""}`).join("\n");
}

function adaptiveSystemContext(profile: UserProfile): string {
  return `## User-adaptive operating contract

The user wants Pi to behave as a preference-aware capability system, not a static prompt bundle.

1. Interpret the user's desired outcome before selecting process or tools.
2. For every nontrivial task, inspect the available skill descriptions and read the matching SKILL.md files before acting. Compose only relevant skills; do not invoke every skill mechanically.
3. Treat explicit user corrections and the durable profile below as higher priority than generic defaults. Ask when a real ambiguity remains.
4. Use specialized agents when isolated context or independent review improves the result; keep simple work in the main Pi agent.
5. Preserve feedback loops: observable tests, direct evidence, and explicit completion criteria.
6. If a needed capability is missing, use a skill-discovery skill when available and ask before trusting a new third-party source.
7. Never store secrets, credentials, sensitive personal data, or one-off task details as durable preferences.

Durable user preferences:
${formatUserProfile(profile)}`;
}

export function getUserProfilePath(): string {
  return PROFILE_FILE;
}

export function registerUserPreferences(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const profile = await loadUserProfile();
    return { systemPrompt: `${event.systemPrompt}\n\n${adaptiveSystemContext(profile)}` };
  });

  pi.registerTool({
    name: "preference_memory",
    label: "Preference Memory",
    description: "Remember, list, or forget explicit durable user preferences so Pi adapts across sessions. Never store secrets, sensitive personal data, or one-off task instructions.",
    promptSnippet: "Remember or inspect explicit durable user preferences",
    promptGuidelines: [
      "Use preference_memory when the user explicitly states a durable workflow, communication, design, or decision preference that should apply across future sessions.",
      "Do not use preference_memory for inferred identity, secrets, credentials, sensitive personal information, project-only facts, or one-off task instructions.",
    ],
    parameters: Type.Object({
      action: StringEnum(["remember", "list", "forget"] as const),
      statement: Type.Optional(Type.String({ description: "Explicit durable preference for remember" })),
      context: Type.Optional(Type.String({ description: "Why or when the preference applies" })),
      id: Type.Optional(Type.String({ description: "Preference id for forget" })),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<PreferenceToolDetails>> {
      if (params.action === "list") {
        const profile = await loadUserProfile();
        return { content: [{ type: "text", text: formatUserProfile(profile) }], details: { profile, path: PROFILE_FILE } };
      }
      if (params.action === "remember") {
        const preference = await rememberUserPreference(params.statement ?? "", params.context);
        const profile = await loadUserProfile();
        return {
          content: [{ type: "text", text: `Remembered durable preference [${preference.id}]: ${preference.statement}` }],
          details: { profile, preference, path: PROFILE_FILE },
        };
      }
      const { removed, profile } = await forgetUserPreference(params.id ?? "");
      return {
        content: [{ type: "text", text: removed ? `Forgot preference ${params.id}.` : `No preference found with id ${params.id}.` }],
        details: { removed, profile, path: PROFILE_FILE },
      };
    },
  });

  pi.registerCommand("preferences", {
    description: "Review and edit Pi's durable user preference profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const current = await loadUserProfile();
      const edited = await ctx.ui.editor("Pi user preferences", JSON.stringify(current, null, 2));
      if (edited === undefined) return;
      try {
        const saved = await saveUserProfile(JSON.parse(edited));
        ctx.ui.notify(`Saved ${saved.preferences.length} durable preferences to ${PROFILE_FILE}`, "info");
      } catch (error) {
        ctx.ui.notify(`Invalid preference profile: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("remember", {
    description: "Explicitly save a durable preference for future Pi sessions",
    handler: async (rawArgs, ctx) => {
      let statement = rawArgs.trim();
      if (!statement && ctx.hasUI) statement = (await ctx.ui.input("Remember preference", "How should Pi work for you?"))?.trim() ?? "";
      if (!statement) return;
      try {
        const preference = await rememberUserPreference(statement, "Explicitly saved by the user with /remember.");
        ctx.ui.notify(`Remembered: ${preference.statement}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
