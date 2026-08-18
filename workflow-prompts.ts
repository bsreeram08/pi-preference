import type { WorkflowAgentProfile } from "./workflow-agents.ts";
import { formatConceptGuidance } from "./workflow-concepts.ts";
import type { AgentResult } from "./types.ts";

export interface PlanningClearance {
  ready: boolean;
  questions: string[];
  assumptions: string[];
}

export type PlanVerdict = "OKAY" | "REJECT";
export type CodeVerdict = "PASS" | "CHANGES_REQUIRED" | "BLOCKED";

const SHARED_WORKFLOW_RULES = `
Work from observable evidence. Verify paths before naming them and distinguish facts from assumptions. Keep scope aligned with the user's request. Do not claim completion from a plan, a diff, or another agent's report. Completion requires direct verification evidence.
`;

export function buildWorkflowSystemPrompt(
  agent: WorkflowAgentProfile,
  reprompterPath: string,
  task: string,
  communityKnowledgePath?: string,
): string {
  const access = agent.readOnly
    ? "You are READ-ONLY. Do not write, edit, delete, install, commit, or generate project files. Safe inspection and verification commands are allowed."
    : "You may modify project files. Preserve unrelated work, do not commit, and run the repository's real tests for every changed behavior.";

  return `You are Pi's ${agent.title} specialist.

Role: ${agent.description}

Operating contract: ${agent.contract}

${SHARED_WORKFLOW_RULES}

${access}

The installed RePrompter guidance is available at ${reprompterPath}. Apply its intent, constraint, output, and observable-success discipline when the request is underspecified.

${formatConceptGuidance(task, agent.id, communityKnowledgePath)}

Return concise Markdown. Include exact file paths and commands whenever they support a consequential finding.`;
}

export function buildDiscoveryTask(task: string, role: "codebase-explorer" | "researcher"): string {
  if (role === "researcher") {
    return `Support planning for this task:

${task}

Inspect project documentation, manifests, lockfiles, and dependency guidance. Use public-web research only when current external documentation is materially required. Prefer official primary sources. Return:
## Relevant Documentation
## Dependency or API Constraints
## Evidence
## Unknowns`;
  }
  return `Map the repository context needed to plan this task:

${task}

Find the relevant files, symbols, tests, conventions, and execution paths. Do not design or implement yet. Return:
## Relevant Paths
## Current Behavior
## Existing Patterns
## Test Surface
## Planning Risks`;
}

export function buildClearanceTask(
  task: string,
  discovery: string,
  interviewNotes: string,
  autonomous: boolean,
): string {
  return `Assess whether this task is clear enough for a decision-complete implementation plan.

USER TASK:
${task}

DISCOVERY:
${discovery || "(none)"}

INTERVIEW NOTES:
${interviewNotes || "(none)"}

${autonomous
    ? "This is an autonomous workflow. Resolve non-critical ambiguity with conservative, explicit assumptions. Mark ready=false only when proceeding could cause destructive, security-sensitive, or fundamentally incompatible work."
    : "Ask only questions whose answers can materially change scope, behavior, architecture, or verification. Do not ask the user to choose implementation trivia that repository evidence can settle."}

Return a short assessment, then exactly one machine-readable marker:
<clearance>{"ready":true,"questions":[],"assumptions":["..."]}</clearance>

Set ready=false and include focused questions when user input is genuinely required.`;
}

export function buildRequirementsAnalysisTask(
  task: string,
  discovery: string,
  interviewNotes: string,
  clearance: PlanningClearance,
): string {
  return `Perform mandatory pre-plan gap analysis.

USER TASK:
${task}

DISCOVERY:
${discovery}

INTERVIEW NOTES:
${interviewNotes || "(none)"}

CLEARANCE ASSUMPTIONS:
${clearance.assumptions.join("\n") || "(none)"}

Find hidden intent, scope creep risks, missing acceptance criteria, failure modes, and repository claims that must be verified before implementation. Do not write the plan. Return:
## Intent and Boundaries
## Material Gaps
## Acceptance Criteria Missing
## Anti-Scope-Creep Guardrails
## Guidance to Planner`;
}

export function buildPlannerTask(
  task: string,
  discovery: string,
  interviewNotes: string,
  requirementsAnalysis: string,
): string {
  return `Create a decision-complete implementation plan. Do not modify files.

USER TASK:
${task}

DISCOVERY:
${discovery}

INTERVIEW NOTES:
${interviewNotes || "(none)"}

REQUIREMENTS ANALYSIS:
${requirementsAnalysis}

The plan must leave no consequential design decision to the implementer. Every step must name verified paths or an explicit discovery action, describe the exact behavior and failure handling, state dependencies, and include observable completion checks.

Return only the plan in Markdown with:
# Plan: <short title>
## Objective
## Scope
## Non-goals
## Assumptions and Decisions
## Execution Steps
Use numbered steps. Each step must contain **Change**, **Paths**, **Dependencies**, and **Done when**.
## Verification Matrix
Name exact tests/checks, scenarios, and expected results.
## Risks and Rollback
## Final Completion Criteria`;
}

export function buildPlanReviewTask(
  role: "quality-reviewer" | "technical-reviewer",
  task: string,
  plan: string,
): string {
  const focus = role === "quality-reviewer"
    ? "Check executability: verified paths, internal consistency, usable starting points, explicit QA scenarios, and whether any missing information completely blocks a worker. Do not reject for minor details a competent implementer can resolve."
    : "Independently check architecture, correctness, failure handling, scope boundaries, and whether the proposed verification actually proves the requested outcome.";
  return `Review this implementation plan before any source change.

USER TASK:
${task}

PLAN:
${plan}

${focus}

Return:
## Verdict
## Blocking Findings
Each blocker must include evidence and a concrete correction.
## Non-blocking Notes
## Verification Assessment
End with exactly one marker:
<plan-verdict>OKAY</plan-verdict>
or
<plan-verdict>REJECT</plan-verdict>`;
}

export function buildPlanRevisionTask(task: string, plan: string, reviews: string): string {
  return `Revise the plan to resolve every verified blocking review finding without adding unrelated scope.

USER TASK:
${task}

CURRENT PLAN:
${plan}

INDEPENDENT REVIEWS:
${reviews}

Return the complete replacement plan using the same required plan structure. Do not discuss the revision process outside the plan.`;
}

export function buildExecutionBriefTask(task: string, plan: string): string {
  return `Prepare execution handoffs for this approved plan. Remain read-only.

USER TASK:
${task}

APPROVED PLAN:
${plan}

Inspect the current repository because it may have changed since planning. Convert the plan into ordered work packets for one write-capable worker. Record prerequisite checks, paths, cumulative conventions, risks, and a verification gate for each packet. Flag a blocker rather than silently rewriting the approved scope.

Return:
## Repository Preflight
## Ordered Work Packets
## Conventions and Decisions to Preserve
## Verification Gates
## Blockers`;
}

export function buildImplementationTask(task: string, plan: string, executionBrief: string): string {
  return `Implement this approved workflow plan end-to-end in the current working tree.

USER TASK:
${task}

APPROVED PLAN:
${plan}

EXECUTION MANAGER BRIEF:
${executionBrief}

Rules:
1. Inspect current files and preserve unrelated user changes.
2. Follow the approved scope and existing repository conventions.
3. Implement one coherent solution; do not create speculative abstractions.
4. Add deterministic regression tests for changed behavior.
5. Run the canonical relevant tests, lint, type checks, or builds documented by the project.
6. Diagnose failures and continue until the relevant checks pass or a concrete blocker remains.
7. Do not commit.

Return:
## Changes
## Files Changed
## Tests Run
## Test Evidence
## Remaining Blockers
## Completion Claim`;
}

export function buildCodeReviewTask(
  role: "quality-reviewer" | "technical-reviewer",
  task: string,
  plan: string,
  implementation: string,
): string {
  const focus = role === "quality-reviewer"
    ? "Check exact conformance to the approved plan, regression coverage, repository standards, and unsupported completion claims."
    : "Check architecture, correctness, edge cases, failure handling, security/reliability consequences, and accidental complexity.";
  return `Review the actual current working tree after implementation. You are read-only.

USER TASK:
${task}

APPROVED PLAN:
${plan}

IMPLEMENTER REPORT:
${implementation}

${focus}

Inspect the real diff and run safe checks when useful. Findings must name severity, path, evidence, and concrete fix. Return:
## Verdict
## Findings
## Verification Gaps
## Evidence
End with exactly one marker:
<code-verdict>PASS</code-verdict>
<code-verdict>CHANGES_REQUIRED</code-verdict>
or
<code-verdict>BLOCKED</code-verdict>`;
}

export function buildIndependentVerificationTask(task: string, plan: string, implementation: string): string {
  return `Act as the independent completion gate. Do not modify files.

USER TASK:
${task}

APPROVED PLAN:
${plan}

IMPLEMENTER REPORT:
${implementation}

Inspect the real working tree and repository instructions. Run the narrowest complete set of canonical tests/checks that proves the requested behavior, including required build or lint checks when documented. A diff, type check alone, or another agent's test claim is not proof. If a relevant check fails, is skipped, or cannot run, verification fails.

Return exact commands with abbreviated results and end with exactly one marker:
<verified/>
or
<failed/>`;
}

export function buildFixTask(
  task: string,
  plan: string,
  implementation: string,
  reviews: string,
  verification: string,
): string {
  return `Fix the current implementation so it satisfies the approved plan and independent verification gate.

USER TASK:
${task}

APPROVED PLAN:
${plan}

PRIOR IMPLEMENTER REPORT:
${implementation}

REVIEWS:
${reviews}

INDEPENDENT VERIFICATION:
${verification}

Inspect the actual tree. Resolve every critical or warning finding that violates the plan, add regression coverage, and rerun the real checks. Do not weaken tests or expand scope. Do not commit.

Return:
## Fixes
## Files Changed
## Tests Run
## Test Evidence
## Remaining Blockers
## Completion Claim`;
}

export function executionManagerReportsBlocker(output: string): boolean {
  const match = output.match(/## Blockers\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (!match) return false;
  const section = match[1].trim().replace(/^[-*]\s*/, "").replace(/[.!]+$/, "").trim();
  if (!section) return false;
  return !/^(?:none|no blockers|no blocking issues|not blocked)$/i.test(section);
}

export function parsePlanningClearance(output: string): PlanningClearance | undefined {
  const match = output.match(/<clearance>\s*([\s\S]*?)\s*<\/clearance>/i);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as Partial<PlanningClearance>;
    if (typeof value.ready !== "boolean") return undefined;
    if (!Array.isArray(value.questions) || value.questions.some((item) => typeof item !== "string")) return undefined;
    if (!Array.isArray(value.assumptions) || value.assumptions.some((item) => typeof item !== "string")) return undefined;
    return {
      ready: value.ready,
      questions: value.questions.map((item) => item.trim()).filter(Boolean),
      assumptions: value.assumptions.map((item) => item.trim()).filter(Boolean),
    };
  } catch {
    return undefined;
  }
}

export function parsePlanVerdict(output: string): PlanVerdict {
  const match = output.match(/<plan-verdict>\s*(OKAY|REJECT)\s*<\/plan-verdict>/i);
  return match?.[1]?.toUpperCase() === "OKAY" ? "OKAY" : "REJECT";
}

export function parseCodeVerdict(output: string): CodeVerdict {
  const match = output.match(/<code-verdict>\s*(PASS|CHANGES_REQUIRED|BLOCKED)\s*<\/code-verdict>/i);
  const value = match?.[1]?.toUpperCase();
  return value === "PASS" ? "PASS" : value === "BLOCKED" ? "BLOCKED" : "CHANGES_REQUIRED";
}

export function planReviewsPass(results: AgentResult[]): boolean {
  return results.length >= 2 && results.every((result) => result.exitCode === 0 && parsePlanVerdict(result.output) === "OKAY");
}

export function codeReviewsPass(results: AgentResult[]): boolean {
  return results.length >= 2 && results.every((result) => result.exitCode === 0 && parseCodeVerdict(result.output) === "PASS");
}

export function verificationPasses(output: string): boolean {
  return /<verified\s*\/>/i.test(output) && !/<failed\s*\/>/i.test(output);
}
