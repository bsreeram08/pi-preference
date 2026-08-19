import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSupervisorAgents, selectSpecialists } from "../agents.ts";
import {
  getWorkflowAgentProfile,
  resolveWorkflowAgent,
  selectPlanningDiscoveryAgentIds,
  validateParallelWorkflowAgents,
} from "../workflow-agents.ts";
import { routeConcepts } from "../workflow-concepts.ts";
import {
  codeReviewsPass,
  executionManagerReportsBlocker,
  parseCodeVerdict,
  parsePlanningClearance,
  parsePlanVerdict,
  planReviewsPass,
  verificationPasses,
} from "../workflow-prompts.ts";
import {
  createWorkflowPlanId,
  getWorkflowPaths,
  loadCurrentWorkflowPlan,
  saveWorkflowPlan,
  type WorkflowPlanState,
} from "../workflow-state.ts";
import { AgentDashboardState } from "../dashboard-state.ts";
import { canDelegateSpecialists, parseSupervisorDecision } from "../supervisor.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../config.ts";
import { SKILL_EVOLUTION_ENABLED_BY_DEFAULT } from "../skill-evolution.ts";
import { createResearchTracks, detectResearchMode, parseResearchAgentOutput } from "../research-prompts.ts";
import {
  auditResearchEvidence,
  createResearchRun,
  getResearchStatePaths,
  loadResearchRun,
  mergeEvidence,
  readEvidence,
  saveResearchRun,
  writeEvidence,
} from "../research-state.ts";
import { extractHtmlDocument, parseYahooSearchResults } from "../research-tools.ts";
import {
  appendDecision,
  ensureProjectState,
  formatQmdResults,
  getProjectPaths,
  loadSession,
  saveSession,
} from "../project.ts";
import {
  assertSafeForParallelWorktrees,
  cleanupWorkerWorkspaces,
  createWorkerWorkspaces,
  describeWorkspaceChanges,
} from "../worktrees.ts";
import type { CouncilSession, Exec } from "../types.ts";

describe("supervisor decision protocol", () => {
  test("accepts project-specific specialist names and maps recognizable roles", () => {
    const agents = resolveSupervisorAgents({
      roles: ["architecture-maintainability-reviewer", "advanced-routing-conformance-reviewer"],
    }, 6);
    expect(agents.map((agent) => agent.id)).toEqual(["architect", "qa"]);
  });

  test("treats review decisions with roles as valid delegation", () => {
    expect(canDelegateSpecialists({ action: "review", phase: "council", roles: ["qa"], rationale: "inspect the proposal" })).toBe(true);
    expect(canDelegateSpecialists({ action: "complete", phase: "council", roles: ["qa"], rationale: "done" })).toBe(false);
  });

  test("parses structured decisions and rejects malformed output", () => {
    expect(parseSupervisorDecision('<workbench-decision>{"action":"delegate","phase":"review","roles":["qa"],"rationale":"changed tests"}</workbench-decision>')).toEqual({
      action: "delegate",
      phase: "review",
      roles: ["qa"],
      rationale: "changed tests",
    });
    expect(parseSupervisorDecision("not structured")).toBeUndefined();
    expect(parseSupervisorDecision('<workbench-decision>{"action":"delegate","roles":[]}</workbench-decision>')).toBeUndefined();
  });
});

describe("agent dashboard state", () => {
  test("groups jobs, selects agents, and keeps finished history separate", () => {
    const dashboard = new AgentDashboardState();
    dashboard.beginRun("run-1");
    dashboard.addJob({ id: "ux", title: "UX Designer", groupId: "round-1", groupTitle: "Round 1" });
    dashboard.addJob({ id: "qa", title: "Quality Engineer", groupId: "round-1", groupTitle: "Round 1" });

    expect(dashboard.getActiveGroups()).toHaveLength(1);
    dashboard.updateJob("ux", { status: "running", latestActivity: "Inspecting changes" });
    dashboard.finishJob("ux", "completed", { output: "done" });

    expect(dashboard.finishedCount).toBe(1);
    expect(dashboard.getFinishedGroups()[0]?.jobs[0]?.output).toBe("done");
    dashboard.selectJob("qa");
    expect(dashboard.getSelectedJob()?.title).toBe("Quality Engineer");
  });

  test("clears the previous run and silently ignores invalid controls", () => {
    const dashboard = new AgentDashboardState();
    dashboard.beginRun("run-1");
    dashboard.addJob({ id: "one", title: "One", groupId: "phase", groupTitle: "Phase" });
    dashboard.selectJob("missing");
    dashboard.toggleGroup("missing");
    dashboard.toggleTool("one", "missing");
    dashboard.beginRun("run-2");

    expect(dashboard.currentRunId).toBe("run-2");
    expect(dashboard.getGroups()).toHaveLength(0);
  });
});

describe("dynamic specialist selection", () => {
  test("always includes intent, opposition, and knowledge perspectives", () => {
    const ids = selectSpecialists("rename one button", 4).map((agent) => agent.id);
    expect(ids).toContain("product");
    expect(ids).toContain("opponent");
    expect(ids).toContain("researcher");
  });

  test("selects domain specialists from the topic", () => {
    const ids = selectSpecialists("Design authentication UI and threat model user tokens", 7).map((agent) => agent.id);
    expect(ids).toContain("security");
    expect(ids).toContain("ux");
  });

});

describe("Pi workflow routing", () => {
  test("routes functional roles to capability-specific models", () => {
    expect(resolveWorkflowAgent("codebase-explorer", DEFAULT_CONFIG)?.model).toBe("openai-codex/gpt-5.4-mini:medium");
    expect(resolveWorkflowAgent("planner", DEFAULT_CONFIG)?.model).toBe("openai-codex/gpt-5.6-sol:high");
    expect(resolveWorkflowAgent("implementer", DEFAULT_CONFIG)?.model).toBe("openai-codex/gpt-5.6-sol:medium");
    expect(resolveWorkflowAgent("quality-reviewer", DEFAULT_CONFIG)?.model).toBe("openai-codex/gpt-5.6-terra:high");
    expect(getWorkflowAgentProfile("task implementer")?.id).toBe("task-implementer");
  });

  test("adds Researcher only when external knowledge can change the plan", () => {
    expect(selectPlanningDiscoveryAgentIds("Rename a local variable")).toEqual(["codebase-explorer"]);
    expect(selectPlanningDiscoveryAgentIds("Integrate the latest SDK documentation")).toEqual(["codebase-explorer", "researcher"]);
  });

  test("composes engineering, design, and experimentation concepts contextually", () => {
    const ui = routeConcepts("Optimize the modal animation latency", "implementer");
    expect(ui.packs).toContain("engineering");
    expect(ui.packs).toContain("design");
    expect(ui.packs).toContain("experimentation");
    expect(ui.skills).toContain("tdd");
    expect(ui.skills).toContain("animate");
    expect(ui.skills).toContain("autoresearch-create");

    const local = routeConcepts("Rename a server constant", "codebase-explorer");
    expect(local.packs).toEqual(["engineering"]);
    expect(local.skills).not.toContain("emil-design-eng");
  });

  test("fails plan and code review closed when markers are missing", () => {
    expect(parsePlanningClearance('<clearance>{"ready":false,"questions":["Which API?"],"assumptions":[]}</clearance>')).toEqual({
      ready: false,
      questions: ["Which API?"],
      assumptions: [],
    });
    expect(parsePlanVerdict("looks fine")).toBe("REJECT");
    expect(parsePlanVerdict("<plan-verdict>OKAY</plan-verdict>")).toBe("OKAY");
    expect(parseCodeVerdict("missing marker")).toBe("CHANGES_REQUIRED");
    expect(parseCodeVerdict("<code-verdict>BLOCKED</code-verdict>")).toBe("BLOCKED");
    expect(verificationPasses("done <verified/>")).toBe(true);
    expect(verificationPasses("<verified/> but also <failed/>")).toBe(false);
    expect(executionManagerReportsBlocker("## Blockers\n- None.\n")).toBe(false);
    expect(executionManagerReportsBlocker("## Blockers\n- Missing migration rollback.\n")).toBe(true);
  });

  test("requires two independent passing reviewers and serializes writers", () => {
    const passing = [
      { agentId: "quality-reviewer", title: "Quality Reviewer", output: "<plan-verdict>OKAY</plan-verdict>", exitCode: 0 },
      { agentId: "technical-reviewer", title: "Technical Reviewer", output: "<plan-verdict>OKAY</plan-verdict>", exitCode: 0 },
    ];
    expect(planReviewsPass(passing)).toBe(true);
    expect(planReviewsPass(passing.slice(0, 1))).toBe(false);
    expect(codeReviewsPass(passing.map((item) => ({ ...item, output: "<code-verdict>PASS</code-verdict>" })))).toBe(true);

    const readers = [resolveWorkflowAgent("quality-reviewer", DEFAULT_CONFIG)!, resolveWorkflowAgent("technical-reviewer", DEFAULT_CONFIG)!];
    expect(validateParallelWorkflowAgents(readers)).toBeUndefined();
    expect(validateParallelWorkflowAgents([resolveWorkflowAgent("implementer", DEFAULT_CONFIG)!])).toContain("read-only only");
  });

  test("persists the current reviewed plan and stable artifact id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-state-test-"));
    try {
      const paths = getWorkflowPaths(root);
      const id = createWorkflowPlanId("Build a polished UI", new Date("2026-08-18T00:00:00.000Z"));
      expect(id).toBe("2026-08-18T00-00-00-000Z-build-a-polished-ui");
      const state: WorkflowPlanState = {
        version: 1,
        id,
        task: "Build a polished UI",
        status: "approved",
        plan: "# Plan\n\n1. Implement it.",
        interviewNotes: "Use the existing design system.",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        reviewRounds: 1,
        planPath: "",
      };
      await saveWorkflowPlan(paths, state);
      expect((await loadCurrentWorkflowPlan(paths))?.status).toBe("approved");
      expect(await fs.readFile(state.planPath, "utf8")).toContain("> Status: approved");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("project settings", () => {
  test("keeps network skill evolution opt-in without explicit configuration", () => {
    expect(SKILL_EVOLUTION_ENABLED_BY_DEFAULT).toBe(false);
  });

  test("normalizes unsafe and invalid values", () => {
    expect(normalizeConfig({
      maxCouncilAgents: 100,
      parallelImplementationWorkers: 1,
      maxFixLoops: -5,
      defaultImplementationSession: "invalid",
      qmdEnabled: "yes",
    })).toEqual({
      maxCouncilAgents: 8,
      parallelImplementationWorkers: 2,
      maxFixLoops: 1,
      defaultImplementationSession: "ask",
      qmdEnabled: true,
      maxResearchAgents: 5,
      researchSourcesPerTrack: 6,
      researchOutputDir: "research",
      researchDefaultDepth: "decision-grade",
      researchRequirePlanConfirmation: true,
      researchWorkerModel: "openai-codex/gpt-5.4-mini:medium",
      researchSynthesisModel: "openai-codex/gpt-5.6-sol:high",
      researchAuditModel: "openai-codex/gpt-5.4:high",
      workflowMaxParallelAgents: 4,
      workflowMaxInterviewRounds: 2,
      workflowMaxPlanReviewLoops: 3,
      workflowMaxFixLoops: 3,
      workflowFastModel: "openai-codex/gpt-5.4-mini:medium",
      workflowPlanningModel: "openai-codex/gpt-5.6-sol:high",
      workflowDeepModel: "openai-codex/gpt-5.6-sol:medium",
      workflowReviewModel: "openai-codex/gpt-5.6-terra:high",
    });
  });

  test("uses opinionated defaults for missing values", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });
});

describe("durable project state", () => {
  test("creates decision storage and round-trips a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-test-"));
    try {
      const paths = getProjectPaths(root);
      await ensureProjectState(paths);
      await appendDecision(paths, "## User decision\n\nUse SQLite because it is local-first.");
      const session: CouncilSession = {
        version: 1,
        projectRoot: root,
        topic: "Build a local app",
        phase: "intent-approved",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["product", "opponent"],
        rounds: [],
      };
      await saveSession(paths, session);
      expect(await loadSession(paths)).toEqual(session);
      expect(await fs.readFile(paths.decisions, "utf8")).toContain("Use SQLite because it is local-first");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("formats QMD evidence with paths and scores", () => {
    const output = formatQmdResults([{ file: "qmd://project/Intent.md", score: 0.88, snippet: "Approved intent" }]);
    expect(output).toContain("qmd://project/Intent.md");
    expect(output).toContain("0.88");
    expect(output).toContain("Approved intent");
  });
});

describe("research planning and evidence", () => {
  test("selects bounded profile-specific tracks", () => {
    expect(detectResearchMode("Find current commercial rent and competitors")).toBe("market");
    expect(detectResearchMode("Check the official SDK specification and API versions")).toBe("technical");
    expect(detectResearchMode("What is the current Node.js LTS release?")).toBe("technical");
    expect(createResearchTracks("market", "fast", 6)).toHaveLength(3);
    expect(createResearchTracks("technical", "decision-grade", 4)).toHaveLength(4);
    expect(createResearchTracks("market", "decision-grade", 6).map((track) => track.id)).toContain("skeptic-gaps");
  });

  test("parses structured agent output and rejects malformed evidence JSON", () => {
    const parsed = parseResearchAgentOutput(`=== FINDINGS ===\nA finding.\n=== EVIDENCE JSON ===\n[{"claim":"A claim","sourceUrl":"https://example.com"}]\n=== OPEN QUESTIONS ===\nCall to verify.`);
    expect(parsed.findings).toBe("A finding.");
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.openQuestions).toBe("Call to verify.");

    const malformed = parseResearchAgentOutput(`=== FINDINGS ===\nA\n=== EVIDENCE JSON ===\nnot-json\n=== OPEN QUESTIONS ===\nB`);
    expect(malformed.evidence).toHaveLength(0);
    expect(malformed.parseWarning).toContain("could not be parsed");
  });

  test("extracts page metadata and Yahoo discovery results", () => {
    const page = extractHtmlDocument(`<html><head><title>Official Price</title><meta property="og:site_name" content="Example Inc"><meta name="description" content="Current plan"><link rel="canonical" href="https://example.com/price"></head><body><nav>Menu</nav><h1>Plan</h1><p>₹99 per hour</p><script>ignore()</script></body></html>`);
    expect(page.title).toBe("Official Price");
    expect(page.publisher).toBe("Example Inc");
    expect(page.text).toContain("₹99 per hour");
    expect(page.text).not.toContain("ignore");

    const yahoo = parseYahooSearchResults(`<div class="dd algo"><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=x/RU=https%3A%2F%2Fexample.com%2Fprice/RK=2/RS=x"><h3><span>Example price</span></h3></a></div><div class="compText"><p>₹99 per hour</p></div></div></li>`);
    expect(yahoo).toEqual([{ title: "Example price", url: "https://example.com/price", snippet: "₹99 per hour" }]);
  });

  test("persists a run and audits source-backed numeric claims", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-research-test-"));
    try {
      const councilState = path.join(root, ".pi", "pi-workbench");
      const tracks = createResearchTracks("market", "fast", 3);
      tracks.forEach((track) => { track.status = "complete"; });
      const run = await createResearchRun(root, councilState, { ...DEFAULT_CONFIG, researchOutputDir: "research" }, {
        question: "What is the current price?",
        decision: "Choose a test price",
        mode: "market",
        depth: "fast",
        geography: "Test City",
        asOf: "2026-08-17",
        tracks,
        providerSummary: ["test"],
      });
      let evidence = mergeEvidence([], [{
        claim: "The official rate is ₹99 per hour.",
        kind: "fact",
        sourceTier: "official",
        confidence: "high",
        verificationStatus: "web-retrieved",
        sourceUrl: "https://example.com/price?utm_source=test",
        sourceTitle: "Official price",
        retrievedAt: "2026-08-17T00:00:00.000Z",
        excerpt: "₹99 per hour",
        volatile: true,
      }], run, "competition-pricing");
      await writeEvidence(root, run, evidence);
      run.status = "complete";
      await saveResearchRun(councilState, run);

      const restored = await loadResearchRun(councilState);
      expect(restored?.id).toBe(run.id);
      expect(getResearchStatePaths(councilState).current).toContain("research/current.json");
      evidence = await readEvidence(root, run);
      expect(evidence[0]?.canonicalUrl).toBe("https://example.com/price");
      const audit = auditResearchEvidence(run, evidence, "The current rate is ₹99 per hour [E-001].");
      expect(audit.status).toBe("pass");

      const broken = auditResearchEvidence(run, [{ ...evidence[0], sourceUrl: undefined, canonicalUrl: undefined }], "The rate is ₹99 [E-001].");
      expect(broken.status).toBe("fail");
      expect(broken.issues.map((issue) => issue.code)).toContain("MISSING_SOURCE");

      evidence[0].verificationStatus = "needs-review";
      evidence[0].contentHash = "old-hash";
      const reviewed = mergeEvidence(evidence, [{
        claim: evidence[0].claim,
        sourceUrl: evidence[0].sourceUrl,
        sourceTier: "official",
        kind: "fact",
        confidence: "high",
        verificationStatus: "web-retrieved",
        retrievedAt: "2026-08-18T00:00:00.000Z",
        excerpt: "Updated ₹99 per hour",
        contentHash: "new-hash",
      }], run, "manual-source");
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0].contentHash).toBe("new-hash");
      expect(reviewed[0].verificationStatus).toBe("web-retrieved");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes unsafe research settings", () => {
    const config = normalizeConfig({
      maxResearchAgents: 99,
      researchSourcesPerTrack: 1,
      researchOutputDir: "../../outside",
      researchDefaultDepth: "unknown",
      researchRequirePlanConfirmation: false,
      researchWorkerModel: "  fast-model  ",
    });
    expect(config.maxResearchAgents).toBe(6);
    expect(config.researchSourcesPerTrack).toBe(3);
    expect(config.researchOutputDir).toBe("research");
    expect(config.researchDefaultDepth).toBe("decision-grade");
    expect(config.researchRequirePlanConfirmation).toBe(false);
    expect(config.researchWorkerModel).toBe("fast-model");
  });
});

describe("parallel worktree safety", () => {
  test("creates isolated workers, exposes their changes, and cleans them up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-git-test-"));
    const actualExec: Exec = async (command, args, options) => {
      const process = Bun.spawn([command, ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = options?.timeout
        ? setTimeout(() => process.kill(), options.timeout)
        : undefined;
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (timeout) clearTimeout(timeout);
      return { stdout, stderr, code };
    };

    try {
      await actualExec("git", ["init", "-q"]);
      await fs.writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
      await actualExec("git", ["add", "README.md"]);
      await actualExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=workbench@example.test", "commit", "-qm", "initial"]);

      await assertSafeForParallelWorktrees(root, actualExec);
      const group = await createWorkerWorkspaces(root, ["developer", "qa"], actualExec);
      expect(group.workers).toHaveLength(2);
      expect(group.workers[0].path).not.toBe(group.workers[1].path);
      await fs.writeFile(path.join(group.workers[0].path, "README.md"), "# Worker change\n", "utf8");
      expect(await describeWorkspaceChanges(group.workers[0], actualExec)).toContain("README.md");
      await cleanupWorkerWorkspaces(root, group, actualExec);
      const listing = await actualExec("git", ["worktree", "list", "--porcelain"]);
      expect(listing.stdout).not.toContain(group.root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("allows council metadata but blocks dirty source files", async () => {
    const cleanExec: Exec = async (_command, args) => {
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0 };
      return { stdout: "?? .pi/pi-workbench/Intent.md\n", stderr: "", code: 0 };
    };
    await expect(assertSafeForParallelWorktrees("/repo", cleanExec)).resolves.toBeUndefined();

    const dirtyExec: Exec = async (_command, args) => {
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0 };
      return { stdout: " M src/app.ts\n?? .pi/pi-workbench/Intent.md\n", stderr: "", code: 0 };
    };
    await expect(assertSafeForParallelWorktrees("/repo", dirtyExec)).rejects.toThrow("src/app.ts");
  });
});
