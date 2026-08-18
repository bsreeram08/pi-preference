import type { AgentSpec } from "./types.ts";

export interface SupervisorRoleSelection {
  roles: string[];
}

const SPECIALISTS: AgentSpec[] = [
  {
    id: "product",
    title: "Product Intent Analyst",
    description: "Clarifies the user's desired outcome, users, value, scope, and decision criteria.",
    triggers: ["product", "user", "customer", "market", "feature", "requirements", "launch", "business", "goal"],
    readOnly: true,
  },
  {
    id: "opponent",
    title: "The Opponent",
    description: "Stress-tests the idea, exposes hidden assumptions, failure modes, and reasons not to proceed.",
    triggers: ["should", "idea", "strategy", "rewrite", "replace", "build", "launch", "risk", "assumption"],
    readOnly: true,
  },
  {
    id: "architect",
    title: "System Architect",
    description: "Examines boundaries, dependencies, constraints, scalability, and architectural consequences.",
    triggers: ["system", "architecture", "api", "backend", "database", "service", "platform", "integration", "scale", "migration"],
    readOnly: true,
  },
  {
    id: "developer",
    title: "Software Developer",
    description: "Tests feasibility, implementation complexity, maintainability, and likely engineering trade-offs.",
    triggers: ["code", "build", "implement", "app", "feature", "refactor", "bug", "swift", "typescript", "api"],
    readOnly: true,
  },
  {
    id: "ux",
    title: "UX Designer",
    description: "Finds user-facing ambiguity, workflow problems, accessibility concerns, and missing states.",
    triggers: ["ui", "ux", "design", "screen", "interface", "workflow", "mobile", "desktop", "user", "experience"],
    readOnly: true,
  },
  {
    id: "security",
    title: "Security Architect",
    description: "Threat-models the idea and identifies privacy, trust, abuse, and data-protection constraints.",
    triggers: ["auth", "security", "privacy", "secret", "permission", "payment", "identity", "data", "token", "threat"],
    readOnly: true,
  },
  {
    id: "qa",
    title: "Quality Engineer",
    description: "Defines observable behavior, edge cases, test strategy, and what would count as done.",
    triggers: ["test", "quality", "reliability", "regression", "edge", "failure", "acceptance", "complete"],
    readOnly: true,
  },
  {
    id: "researcher",
    title: "Knowledge Researcher",
    description: "Uses QMD and available project knowledge to surface prior decisions, evidence, and unknowns.",
    triggers: ["research", "compare", "best", "practice", "evidence", "docs", "knowledge", "prior", "existing"],
    readOnly: true,
  },
  {
    id: "hiring",
    title: "Hiring Advisor",
    description: "Clarifies staffing, role design, capability gaps, and organizational implications.",
    triggers: ["hire", "hiring", "team", "staff", "candidate", "role", "recruit", "person"],
    readOnly: true,
  },
];

const ALWAYS_INCLUDE = new Set(["product", "opponent", "researcher"]);

function scoreAgent(agent: AgentSpec, topic: string): number {
  const lower = topic.toLowerCase();
  return agent.triggers.reduce((score, trigger) => score + (lower.includes(trigger) ? 2 : 0), 0);
}

export function selectSpecialists(topic: string, max = 6): AgentSpec[] {
  const limit = Math.max(ALWAYS_INCLUDE.size, max);
  const ranked = SPECIALISTS
    .map((agent) => ({ agent, score: scoreAgent(agent, topic) }))
    .sort((a, b) => b.score - a.score || a.agent.title.localeCompare(b.agent.title));

  const selected = SPECIALISTS.filter((agent) => ALWAYS_INCLUDE.has(agent.id));
  for (const { agent, score } of ranked) {
    if (selected.length >= limit) break;
    if (score <= 0 || selected.some((candidate) => candidate.id === agent.id)) continue;
    selected.push(agent);
  }

  if (selected.length < Math.min(limit, 4)) {
    for (const { agent } of ranked) {
      if (selected.length >= Math.min(limit, 4)) break;
      if (!selected.some((candidate) => candidate.id === agent.id)) selected.push(agent);
    }
  }

  return selected.slice(0, limit);
}

export function getAgentById(id: string): AgentSpec | undefined {
  return SPECIALISTS.find((agent) => agent.id === id);
}

export function listSpecialists(): AgentSpec[] {
  return [...SPECIALISTS];
}

const ROLE_ALIASES: Array<[RegExp, string]> = [
  [/architect|architecture|maintainability|system/i, "architect"],
  [/qa|quality|test|verification|regression|conformance/i, "qa"],
  [/security|threat|privacy|trust/i, "security"],
  [/developer|development|implementation|code/i, "developer"],
  [/ux|ui|design|interface|experience/i, "ux"],
  [/research|knowledge|evidence/i, "researcher"],
  [/product|intent|user|outcome/i, "product"],
  [/opponent|challenge|risk|critic/i, "opponent"],
];

function dynamicRole(role: string): AgentSpec {
  const id = `dynamic-${role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "specialist"}`;
  const title = role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    id,
    title: title || "Dynamic Specialist",
    description: `Provides a focused read-only perspective for the Supervisor role: ${role}.`,
    triggers: [],
    readOnly: true,
  };
}

export function resolveSupervisorAgents(selection: SupervisorRoleSelection, max: number): AgentSpec[] {
  const available = listSpecialists();
  const selected: AgentSpec[] = [];
  for (const role of selection.roles) {
    const exact = available.find((agent) => agent.id === role);
    const alias = ROLE_ALIASES.find(([pattern]) => pattern.test(role))?.[1];
    const agent = exact ?? (alias ? available.find((candidate) => candidate.id === alias) : undefined) ?? dynamicRole(role);
    if (!selected.some((candidate) => candidate.id === agent.id)) selected.push(agent);
    if (selected.length >= max) break;
  }
  if (selected.length === 0) throw new Error(`Supervisor selected no specialists for this phase.`);
  return selected;
}
