import { fileURLToPath } from "node:url";
import { auditPersistedResearch, collectResearchSources, recordResearchPage, recordUserObservation, sourceText, type ResearchSource } from "./research-provenance.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";
import {
  ensureProjectState,
  ensureQmdCollections,
  findProjectRoot,
  formatQmdResults,
  getProjectPaths,
  refreshQmd,
  searchQmd,
} from "./project.ts";
import {
  buildResearchAuditTask,
  buildResearchAnalysisTask,
  buildResearchPlan,
  buildResearchSynthesisTask,
  buildResearchSystemPrompt,
  buildResearchTrackTask,
  createResearchTracks,
  detectResearchMode,
  formatEvidenceIndex,
  parseIndependentAuditStatus,
  parseResearchAgentOutput,
  researchAgentForTrack,
} from "./research-prompts.ts";
import {
  createResearchRun,
  formatResearchAudit,
  formatResearchContext,
  loadResearchRun,
  mergeEvidence,
  mergeResearchTrack,
  canonicalizeResearchUrl,
  preserveResearchAuditAfterRefresh,
  readEvidence,
  readResearchFile,
  saveResearchRun,
  writeEvidence,
  writeResearchFile,
  writeResearchManifest,
} from "./research-state.ts";
import { availableResearchSearchProviders, fetchResearchUrl } from "./research-tools.ts";
import type {
  ResearchAuditResult,
  ResearchDepth,
  ResearchEvidence,
  ResearchMode,
  ResearchRun,
} from "./research-types.ts";
import { runAgentsParallel, runSingleAgent } from "./subagents.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import type { AgentSpec, Exec } from "./types.ts";

const ISO = () => new Date().toISOString();

interface ResearchRegistrationDependencies {
  exec: Exec;
  dashboard: WorkbenchDashboardController;
  report: (title: string, body: string) => void;
}

interface StartResearchInput {
  question?: string;
  mode?: ResearchMode;
  depth?: ResearchDepth;
  decision?: string;
  geography?: string;
  asOf?: string;
}

function statusRank(status: "pass" | "warning" | "fail"): number {
  return status === "fail" ? 2 : status === "warning" ? 1 : 0;
}

function recomputeAuditStatus(audit: ResearchAuditResult): void {
  audit.status = audit.issues.some((issue) => issue.severity === "critical")
    ? "fail"
    : audit.issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "pass";
}

function modeLabel(mode: ResearchMode): string {
  return mode === "market" ? "Market / local-business research" : mode === "technical" ? "Technical / documentation research" : "General decision research";
}

function depthLabel(depth: ResearchDepth): string {
  return depth === "fast" ? "Fast scan (3 tracks)" : "Decision-grade (5 tracks + independent audit)";
}

function trackPath(run: ResearchRun, trackId: string): string {
  return `${run.paths.runDir}/tracks/${trackId}.md`;
}

function renderPlanPreview(input: {
  question: string;
  decision: string;
  mode: ResearchMode;
  depth: ResearchDepth;
  geography?: string;
  asOf: string;
  tracks: ReturnType<typeof createResearchTracks>;
  providers: string[];
  sourcesPerTrack: number;
}): string {
  return [
    `Question: ${input.question}`,
    `Decision: ${input.decision}`,
    `Profile: ${modeLabel(input.mode)} / ${depthLabel(input.depth)}`,
    `As of: ${input.asOf}${input.geography ? ` / ${input.geography}` : ""}`,
    `Source target: ${input.sourcesPerTrack} per track`,
    `Routes: ${input.providers.join(", ")}`,
    ``,
    ...input.tracks.map((track, index) => `${index + 1}. ${track.title} — ${track.scope}`),
    ``,
    `The run will write a report, evidence JSONL, audit and manifest under the project research directory. Configured API providers may consume quota.`,
  ].join("\n");
}

async function chooseMode(ctx: any, detected: ResearchMode): Promise<ResearchMode | undefined> {
  const ordered = [detected, ...(["market", "technical", "general"] as ResearchMode[]).filter((mode) => mode !== detected)];
  const labels = ordered.map(modeLabel);
  const selected = await ctx.ui.select("Research profile", labels);
  const index = labels.indexOf(selected ?? "");
  return index >= 0 ? ordered[index] : undefined;
}

async function chooseDepth(ctx: any, preferred: ResearchDepth): Promise<ResearchDepth | undefined> {
  const ordered = [preferred, ...(preferred === "fast" ? ["decision-grade" as const] : ["fast" as const])];
  const labels = ordered.map(depthLabel);
  const selected = await ctx.ui.select("Research depth", labels);
  const index = labels.indexOf(selected ?? "");
  return index >= 0 ? ordered[index] : undefined;
}

function researchProgress(ctx: any, label: string): { update: (message: string) => void; finish: (run?: ResearchRun) => void } {
  return {
    update(message: string) {
      if (ctx.hasUI) ctx.ui.setStatus("pi-workbench", `${label}: ${message}`);
    },
    finish(run?: ResearchRun) {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(
        "pi-workbench",
        run ? `research: ${run.status} • ${run.evidenceCount} evidence • audit ${run.auditStatus ?? "pending"}` : undefined,
      );
    },
  };
}

function synthesisSystemPrompt(): string {
  return `You are the Workbench Research synthesis editor. You are read-only. Synthesize only from the supplied track reports and canonical evidence ledger. Evidence outranks agent consensus. Preserve uncertainty, source dates, geography and conflicting values. Never invent a citation or imply that web evidence was confirmed by phone/site visit.`;
}

function auditSystemPrompt(): string {
  return `You are the independent Workbench Research evidence auditor. You are read-only. Do not repair or rewrite the report. Verify report claims against the supplied ledger and the actual cited source pages, recompute arithmetic, and fail material unsupported, inaccessible, excerpt-mismatched, or mis-cited claims. Agent agreement and a structured ledger are not evidence by themselves.`;
}

async function retrieveResearchPage(deps: ResearchRegistrationDependencies, url: string, signal?: AbortSignal, excerpts: string[] = []) {
  let fetched: Awaited<ReturnType<typeof fetchResearchUrl>> | undefined;
  try {
    fetched = await fetchResearchUrl(url, { maxChars: 100_000, signal });
    if (!excerpts.length || excerpts.some((excerpt) => sourceText(fetched!.text).includes(sourceText(excerpt)))) return fetched;
  } catch { signal?.throwIfAborted(); }
  try {
    const result = await deps.exec(process.execPath, [fileURLToPath(new URL("./research-browser.mjs", import.meta.url)), url, "100000"], { signal, timeout: 70_000 });
    if (result.code !== 0) throw new Error("Research browser could not retrieve the source.");
    const page = JSON.parse(result.stdout);
    if (page.status < 200 || page.status >= 300 || !page.status) throw new Error("Research browser did not retrieve a successful source page.");
    return { ...page, contentType: "text/html" } as Awaited<ReturnType<typeof fetchResearchUrl>>;
  } catch (error) {
    signal?.throwIfAborted();
    if (fetched) return fetched; // Preserve observed static content; unmatched excerpts remain unverified.
    throw error;
  }
}

async function performIndependentAudit(
  root: string,
  run: ResearchRun,
  report: string,
  evidence: ResearchEvidence[],
  model: string | null,
  progress: (message: string) => void,
  dashboard: WorkbenchDashboardController,
  signal?: AbortSignal,
  groupId = "research-audit",
): Promise<string> {
  const agent: AgentSpec = {
    id: "research-evidence-auditor",
    title: "Independent evidence auditor",
    description: "Audits citations, provenance, arithmetic, staleness and fact/inference separation.",
    triggers: [],
    readOnly: true,
    researchTools: true,
    ...(model ? { model } : {}),
  };
  const result = await runSingleAgent(
    root,
    agent,
    auditSystemPrompt(),
    buildResearchAuditTask(run, report, evidence),
    signal,
    progress,
    { dashboard, groupId, groupTitle: "Independent audit", jobId: `${groupId}-auditor` },
  );
  if (result.exitCode !== 0 || !result.output.trim()) return `Independent auditor did not complete successfully.\n<research-audit status="fail"/>`;
  return result.output;
}

async function startResearch(
  pi: ExtensionAPI,
  deps: ResearchRegistrationDependencies,
  ctx: any,
  supplied: StartResearchInput,
  signal?: AbortSignal,
): Promise<{ summary: string; run?: ResearchRun }> {
  const trustRequired = guardSubagentLaunch(ctx);
  if (trustRequired) return { summary: trustRequired };
  if (!ctx.hasUI) return { summary: "Deep research requires interactive or RPC UI for scope and cost confirmation." };
  const root = await findProjectRoot(ctx.cwd, deps.exec);
  const projectPaths = getProjectPaths(root);
  await ensureProjectState(projectPaths);
  const config = await loadConfig(projectPaths);

  let question = supplied.question?.trim() ?? "";
  if (!question) question = (await ctx.ui.editor("Research question", "What should Pi investigate, and what decision will it inform?"))?.trim() ?? "";
  if (!question) return { summary: "Research cancelled: no question was supplied." };

  const mode = supplied.mode ?? await chooseMode(ctx, detectResearchMode(question));
  if (!mode) return { summary: "Research cancelled while choosing a profile." };
  const depth = supplied.depth ?? await chooseDepth(ctx, config.researchDefaultDepth);
  if (!depth) return { summary: "Research cancelled while choosing depth." };
  let decision = supplied.decision?.trim() ?? "";
  if (!decision) {
    decision = (await ctx.ui.editor("Decision to support", `Use the evidence to decide:\n${question}`))?.trim() ?? "";
    if (!decision) return { summary: "Research cancelled: the decision context is required." };
  }
  let geography = supplied.geography?.trim();
  if (mode === "market" && geography === undefined) {
    const entered = await ctx.ui.input("Geography / catchment", "e.g. Guduvancheri and Urapakkam, Chennai");
    if (entered === undefined) return { summary: "Research cancelled while setting geography." };
    geography = entered.trim() || undefined;
  }
  const asOf = supplied.asOf?.trim() || new Date().toISOString().slice(0, 10);
  const tracks = createResearchTracks(mode, depth, config.maxResearchAgents);
  const providers = availableResearchSearchProviders();
  const preview = renderPlanPreview({
    question, decision, mode, depth, geography, asOf, tracks, providers,
    sourcesPerTrack: config.researchSourcesPerTrack,
  });
  if (config.researchRequirePlanConfirmation) {
    const confirmed = await ctx.ui.confirm("Run this research plan?", preview);
    if (!confirmed) return { summary: "Research plan was not confirmed." };
  }

  const current = await loadResearchRun(projectPaths.stateDir);
  if (current && ["planning", "running", "synthesizing", "auditing"].includes(current.status)) {
    const replace = await ctx.ui.confirm("Replace an unfinished research run?", `Current run: ${current.question}\nStatus: ${current.status}\nIts files will remain on disk.`);
    if (!replace) return { summary: "Research cancelled; the unfinished run remains current." };
  }

  const run = await createResearchRun(root, projectPaths.stateDir, config, {
    question, decision, mode, depth, geography, asOf, tracks, providerSummary: providers,
  });
  await writeResearchFile(root, run.paths.plan, buildResearchPlan(run));
  run.status = "running";
  run.tracks.forEach((track) => { track.status = "running"; });
  await saveResearchRun(projectPaths.stateDir, run);

  deps.dashboard.beginRun(`research-${run.id}`);
  const progress = researchProgress(ctx, "Workbench Research");
  progress.update(`0/${run.tracks.length} tracks • 0 evidence`);
  let evidence: ResearchEvidence[] = [];
  try {
    let qmdContext = "No QMD project context was available.";
    if (config.qmdEnabled) {
      await ensureQmdCollections(projectPaths, deps.exec);
      await refreshQmd(deps.exec);
      qmdContext = formatQmdResults(await searchQmd(projectPaths, deps.exec, `${question} ${decision}`, 10));
    }

    const analytical = (track: ResearchRun["tracks"][number]) => /quantitative/.test(track.id);
    const collectionTracks = run.tracks.filter((track) => !analytical(track));
    const agents = collectionTracks.map((track) => researchAgentForTrack(track, config.researchWorkerModel));
    const results = await runAgentsParallel(
      root,
      agents,
      (agent) => buildResearchSystemPrompt(collectionTracks[agents.indexOf(agent)]),
      (agent) => buildResearchTrackTask(run, collectionTracks[agents.indexOf(agent)], qmdContext),
      signal,
      progress.update,
      { dashboard: deps.dashboard, groupId: "research-tracks", groupTitle: "Research tracks" },
    );

    const trackReports: string[] = [];
    const sourceCache = new Map<string, ResearchSource>();
    const orderedTracks = [...collectionTracks, ...run.tracks.filter(analytical)];
    for (let index = 0; index < run.tracks.length; index++) {
      const track = orderedTracks[index];
      const result = analytical(track)
        ? await runSingleAgent(root, { ...researchAgentForTrack(track, config.researchWorkerModel), allowBash: true }, buildResearchSystemPrompt(track),
          buildResearchAnalysisTask(run, track, trackReports.join("\n\n"), evidence),
          signal, progress.update, { dashboard: deps.dashboard, groupId: "research-analysis", groupTitle: "Quantitative analysis", jobId: track.id })
        : results[collectionTracks.indexOf(track)];
      const parsed = parseResearchAgentOutput(result.output);
      await collectResearchSources(root, run, parsed.evidence, (url) => retrieveResearchPage(deps, url, signal, parsed.evidence.filter((entry) => canonicalizeResearchUrl(entry.sourceUrl) === url).map((entry) => entry.excerpt).filter((excerpt): excerpt is string => typeof excerpt === "string" && Boolean(excerpt.trim()))), sourceCache, signal);
      const merged = mergeResearchTrack(evidence, parsed.evidence, run, track.id, parsed.findings, parsed.openQuestions, sourceCache);
      evidence = merged.evidence;
      parsed.findings = merged.findings;
      parsed.openQuestions = merged.openQuestions;
      track.status = result.exitCode === 0 && !parsed.parseWarning ? "complete" : "failed";
      track.agentId = result.agentId;
      track.completedAt = ISO();
      track.outputPath = trackPath(run, track.id);
      if (result.error) track.error = result.error;
      const body = [
        `# ${track.title}`,
        ``,
        `- **Track:** ${track.id}`,
        `- **Status:** ${track.status}`,
        `- **Completed:** ${track.completedAt}`,
        parsed.parseWarning ? `- **Parse warning:** ${parsed.parseWarning}` : "",
        ``,
        `## Findings`,
        ``,
        parsed.findings || "No findings returned.",
        ``,
        `## Open questions and blocked evidence`,
        ``,
        parsed.openQuestions || "None stated.",
      ].filter((line) => line !== "").join("\n");
      await writeResearchFile(root, track.outputPath, body);
      trackReports.push(body);
      await writeEvidence(root, run, evidence);
      await saveResearchRun(projectPaths.stateDir, run);
      progress.update(`${index + 1}/${run.tracks.length} tracks • ${evidence.length} evidence`);
    }

    if (run.tracks.every((track) => track.status === "failed")) {
      run.status = "blocked";
      const blockedReport = `# Research blocked\n\nEvery research track failed. Inspect the track files and provider/tool errors before retrying.\n\n${trackReports.join("\n\n---\n\n")}`;
      await writeResearchFile(root, run.paths.report, blockedReport);
      const audit = await auditPersistedResearch(root, run, evidence, blockedReport);
      run.auditStatus = audit.status;
      run.auditIssueCount = audit.issues.length;
      await writeResearchFile(root, run.paths.audit, formatResearchAudit(run, audit));
      await writeResearchManifest(root, run, evidence);
      await saveResearchRun(projectPaths.stateDir, run);
      deps.report("Research blocked", `Every track failed.\n\n- Report: ${run.paths.report}\n- Audit: ${run.paths.audit}`);
      return { summary: "Research blocked because every track failed. Inspect the saved track reports.", run };
    }

    run.status = "synthesizing";
    await saveResearchRun(projectPaths.stateDir, run);
    progress.update(`synthesizing ${evidence.length} evidence records`);
    const synthesisAgent: AgentSpec = {
      id: "research-synthesis",
      title: "Research synthesis editor",
      description: "Synthesizes parallel findings into a cited decision report without adding unsupported claims.",
      triggers: [],
      readOnly: true,
      ...(config.researchSynthesisModel ? { model: config.researchSynthesisModel } : {}),
    };
    const synthesis = await runSingleAgent(
      root,
      synthesisAgent,
      synthesisSystemPrompt(),
      buildResearchSynthesisTask(run, trackReports.join("\n\n---\n\n"), evidence),
      signal,
      progress.update,
      { dashboard: deps.dashboard, groupId: "research-synthesis", groupTitle: "Synthesis", jobId: "research-synthesis" },
    );
    if (synthesis.exitCode !== 0 || !synthesis.output.trim()) throw new Error("Research synthesis failed; saved track reports remain available.");
    const synthesisBody = synthesis.output;
    const reportHeader = `> Workbench Research run: ${run.id}  \n> Evidence as of: ${run.asOf}  \n> Geography: ${run.geography ?? "not constrained"}  \n> Web-derived prices, listings, ratings and availability remain unverified until directly confirmed.\n\n`;
    const fullReport = `${reportHeader}${synthesisBody.trim()}\n\n${formatEvidenceIndex(evidence)}`;
    await writeResearchFile(root, run.paths.report, fullReport);

    run.status = "auditing";
    await saveResearchRun(projectPaths.stateDir, run);
    progress.update(`independent audit • ${evidence.length} evidence`);
    const independentAudit = await performIndependentAudit(
      root, run, fullReport, evidence, config.researchAuditModel, progress.update, deps.dashboard, signal,
    );
    const deterministicAudit = await auditPersistedResearch(root, run, evidence, fullReport);
    const independentStatus = parseIndependentAuditStatus(independentAudit);
    run.independentAuditStatus = independentStatus ?? "fail";
    if (!independentStatus) {
      deterministicAudit.issues.push({ severity: "critical", code: "AUDITOR_UNSTRUCTURED", message: "Independent auditor did not return a valid status marker." });
    } else if (statusRank(independentStatus) > statusRank(deterministicAudit.status)) {
      deterministicAudit.issues.push({
        severity: independentStatus === "fail" ? "critical" : "warning",
        code: "INDEPENDENT_AUDIT",
        message: `Independent model audit returned ${independentStatus.toUpperCase()}; inspect its findings below.`,
      });
    }
    recomputeAuditStatus(deterministicAudit);
    await writeResearchFile(root, run.paths.audit, formatResearchAudit(run, deterministicAudit, independentAudit));
    run.auditStatus = deterministicAudit.status;
    run.auditIssueCount = deterministicAudit.issues.length;
    run.status = deterministicAudit.status === "pass" ? "complete" : "complete-with-gaps";
    await writeResearchManifest(root, run, evidence);
    await saveResearchRun(projectPaths.stateDir, run);
    if (config.qmdEnabled) await refreshQmd(deps.exec);

    const completed = run.tracks.filter((track) => track.status === "complete").length;
    const summary = `Research ${run.status}: ${completed}/${run.tracks.length} tracks, ${evidence.length} evidence records, audit ${run.auditStatus}.`;
    deps.report(
      "Workbench Research complete",
      `${summary}\n\n- Report: ${run.paths.report}\n- Evidence: ${run.paths.evidence}\n- Audit: ${run.paths.audit}\n- Manifest: ${run.paths.manifest}\n\nRun \`/research-status\`, \`/research-synthesize\`, \`/research-audit\`, or \`/research-refresh\` as needed.`,
    );
    return { summary, run };
  } catch (error) {
    run.status = "blocked";
    await saveResearchRun(projectPaths.stateDir, run);
    const message = error instanceof Error ? error.message : String(error);
    deps.report("Research interrupted", `${message}\n\nPartial outputs remain at ${run.paths.runDir}.`);
    return { summary: `Research interrupted: ${message}`, run };
  } finally {
    deps.dashboard.endRun();
    progress.finish(run);
  }
}

async function requireCurrentRun(ctx: any, deps: ResearchRegistrationDependencies): Promise<{ root: string; projectPaths: ReturnType<typeof getProjectPaths>; run: ResearchRun } | undefined> {
  const root = await findProjectRoot(ctx.cwd, deps.exec);
  const projectPaths = getProjectPaths(root);
  const run = await loadResearchRun(projectPaths.stateDir);
  if (!run) {
    deps.report("No research run", "Start one with `/research <question>`.");
    return undefined;
  }
  return { root, projectPaths, run };
}

async function addSource(ctx: any, deps: ResearchRegistrationDependencies, rawArgs: string): Promise<void> {
  if (!ctx.hasUI) return;
  const current = await requireCurrentRun(ctx, deps);
  if (!current) return;
  const firstSpace = rawArgs.trim().indexOf(" ");
  let url = firstSpace < 0 ? rawArgs.trim() : rawArgs.trim().slice(0, firstSpace);
  let claim = firstSpace < 0 ? "" : rawArgs.trim().slice(firstSpace + 1).trim();
  if (!url) url = (await ctx.ui.input("Source URL", "https://..."))?.trim() ?? "";
  if (!url) return;
  let fetched: Awaited<ReturnType<typeof fetchResearchUrl>> | undefined;
  let fetchError = "";
  try { fetched = await retrieveResearchPage(deps, url); } catch (error) { fetchError = error instanceof Error ? error.message : String(error); }
  if (!claim) claim = (await ctx.ui.editor("Claim supported by this source", fetched?.description ?? "State one atomic claim."))?.trim() ?? "";
  if (!claim) return;
  const excerpt = (await ctx.ui.editor("Exact supporting excerpt", fetched?.text.slice(0, 800) ?? fetchError))?.trim() ?? "";
  const tierLabel = await ctx.ui.select("Source tier", ["Primary", "Official", "Direct platform/listing/social", "Secondary", "Unknown"]);
  if (!tierLabel) return;
  const tierMap: Record<string, ResearchEvidence["sourceTier"]> = {
    Primary: "primary", Official: "official", "Direct platform/listing/social": "direct-platform", Secondary: "secondary", Unknown: "unknown",
  };
  const volatile = await ctx.ui.confirm("Volatile source?", "Choose Yes for prices, listings, ratings, menus, availability and other frequently changing data.");
  let evidence = await readEvidence(current.root, current.run);
  const sources = new Map<string, ResearchSource>();
  if (fetched) sources.set(canonicalizeResearchUrl(url)!, await recordResearchPage(current.root, current.run, fetched));
  evidence = mergeEvidence(evidence, [{
    claim,
    kind: "reported-claim",
    sourceTier: tierMap[tierLabel],
    confidence: fetched ? "medium" : "low",
    verificationStatus: fetched ? "web-retrieved" : "unverified",
    sourceUrl: url,
    canonicalUrl: fetched?.canonicalUrl ?? fetched?.finalUrl,
    sourceTitle: fetched?.title,
    publisher: fetched?.publisher,
    publishedAt: fetched?.publishedAt,
    retrievedAt: fetched?.retrievedAt ?? ISO(),
    excerpt: excerpt || fetched?.description,
    volatile,
    contentHash: fetched?.contentHash,
    notes: fetchError || undefined,
  }], current.run, "manual-source", { sources });
  await writeEvidence(current.root, current.run, evidence);
  current.run.status = "complete-with-gaps";
  current.run.auditStatus = undefined;
  current.run.auditIssueCount = undefined;
  await saveResearchRun(current.projectPaths.stateDir, current.run);
  await writeResearchManifest(current.root, current.run, evidence);
  deps.report("Research source added", `${claim}\n\nSource: ${url}\nEvidence records: ${evidence.length}${fetchError ? `\n\nFetch warning: ${fetchError}` : ""}`);
}

async function addObservation(ctx: any, deps: ResearchRegistrationDependencies, rawArgs: string): Promise<void> {
  if (!ctx.hasUI) return;
  const current = await requireCurrentRun(ctx, deps);
  if (!current) return;
  const type = await ctx.ui.select("Observation type", ["Phone call", "Site visit", "Vendor quote", "Photograph", "Measurement", "Other"]);
  if (!type) return;
  let details = rawArgs.trim();
  if (!details) details = (await ctx.ui.editor("Observed evidence", "Record what was directly observed or said. Keep interpretation separate."))?.trim() ?? "";
  if (!details) return;
  const source = (await ctx.ui.input("Source / person / file", "Landlord, vendor, image path, measurement method..."))?.trim();
  if (source === undefined) return;
  const observedAt = (await ctx.ui.input("Observation date", new Date().toISOString().slice(0, 10)))?.trim();
  if (observedAt === undefined) return;
  const claim = (await ctx.ui.editor("Atomic claim supported", details))?.trim() ?? "";
  if (!claim) return;
  let evidence = await readEvidence(current.root, current.run);
  evidence = mergeEvidence(evidence, [{
    claim,
    kind: "fact",
    sourceTier: "user-observation",
    confidence: "high",
    verificationStatus: "user-verified",
    retrievedAt: ISO(),
    observedAt: observedAt || new Date().toISOString().slice(0, 10),
    excerpt: details,
    volatile: type === "Phone call" || type === "Vendor quote",
    notes: `${type}${source ? ` — ${source}` : ""}`,
  }], current.run, "user-observation", { observation: await recordUserObservation(current.root, current.run, details, observedAt || new Date().toISOString().slice(0, 10)) });
  await writeEvidence(current.root, current.run, evidence);
  current.run.status = "complete-with-gaps";
  current.run.auditStatus = undefined;
  current.run.auditIssueCount = undefined;
  await saveResearchRun(current.projectPaths.stateDir, current.run);
  await writeResearchManifest(current.root, current.run, evidence);
  deps.report("Verified observation recorded", `**${type}:** ${claim}\n\nEvidence records: ${evidence.length}`);
}

async function synthesizeCurrent(ctx: any, deps: ResearchRegistrationDependencies): Promise<void> {
  if (guardSubagentLaunch(ctx)) return;
  const current = await requireCurrentRun(ctx, deps);
  if (!current) return;
  const config = await loadConfig(current.projectPaths);
  const evidence = await readEvidence(current.root, current.run);
  const trackReports = (
    await Promise.all(current.run.tracks.map((track) => track.outputPath ? readResearchFile(current.root, track.outputPath) : Promise.resolve("")))
  ).filter(Boolean);
  if (!trackReports.length) {
    deps.report("Cannot synthesize research", "No completed track reports are available.");
    return;
  }
  deps.dashboard.beginRun(`research-resynthesis-${Date.now()}`);
  const progress = researchProgress(ctx, "Research synthesis");
  try {
    current.run.status = "synthesizing";
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    const synthesisAgent: AgentSpec = {
      id: "research-resynthesis",
      title: "Research synthesis editor",
      description: "Re-synthesizes track findings plus newly added evidence into a cited decision report.",
      triggers: [],
      readOnly: true,
      ...(config.researchSynthesisModel ? { model: config.researchSynthesisModel } : {}),
    };
    const synthesis = await runSingleAgent(
      current.root,
      synthesisAgent,
      synthesisSystemPrompt(),
      buildResearchSynthesisTask(current.run, trackReports.join("\n\n---\n\n"), evidence),
      undefined,
      progress.update,
      { dashboard: deps.dashboard, groupId: "research-resynthesis", groupTitle: "Re-synthesis", jobId: "research-resynthesis" },
    );
    if (synthesis.exitCode !== 0 || !synthesis.output.trim()) throw new Error("Research synthesis failed; previous report retained.");
    const reportHeader = `> Workbench Research run: ${current.run.id}  \n> Re-synthesized: ${ISO()}  \n> Evidence as of: ${current.run.asOf}  \n> Geography: ${current.run.geography ?? "not constrained"}  \n> Web-derived prices, listings, ratings and availability remain unverified until directly confirmed.\n\n`;
    const fullReport = `${reportHeader}${synthesis.output.trim()}\n\n${formatEvidenceIndex(evidence)}`;
    await writeResearchFile(current.root, current.run.paths.report, fullReport);

    current.run.status = "auditing";
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    const independent = await performIndependentAudit(
      current.root,
      current.run,
      fullReport,
      evidence,
      config.researchAuditModel,
      progress.update,
      deps.dashboard,
      undefined,
      "research-resynthesis-audit",
    );
    const audit = await auditPersistedResearch(current.root, current.run, evidence, fullReport);
    const independentStatus = parseIndependentAuditStatus(independent);
    current.run.independentAuditStatus = independentStatus ?? "fail";
    if (!independentStatus) audit.issues.push({ severity: "critical", code: "AUDITOR_UNSTRUCTURED", message: "Independent auditor omitted its status marker." });
    else if (statusRank(independentStatus) > statusRank(audit.status)) audit.issues.push({ severity: independentStatus === "fail" ? "critical" : "warning", code: "INDEPENDENT_AUDIT", message: `Independent audit returned ${independentStatus.toUpperCase()}.` });
    recomputeAuditStatus(audit);
    current.run.auditStatus = audit.status;
    current.run.auditIssueCount = audit.issues.length;
    current.run.status = audit.status === "pass" ? "complete" : "complete-with-gaps";
    await writeResearchFile(current.root, current.run.paths.audit, formatResearchAudit(current.run, audit, independent));
    await writeResearchManifest(current.root, current.run, evidence);
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    if (config.qmdEnabled) await refreshQmd(deps.exec);
    deps.report("Research re-synthesized", `Status: **${current.run.status}**\nAudit: **${audit.status.toUpperCase()}**\n\nReport: ${current.run.paths.report}\nAudit: ${current.run.paths.audit}`);
  } catch (error) {
    current.run.status = "blocked";
    current.run.auditStatus = "fail";
    current.run.independentAuditStatus = "fail";
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    deps.report("Research operation failed", error instanceof Error ? error.message : String(error));
  } finally {
    deps.dashboard.endRun();
    progress.finish(current.run);
  }
}

async function auditCurrent(ctx: any, deps: ResearchRegistrationDependencies): Promise<void> {
  if (guardSubagentLaunch(ctx)) return;
  const current = await requireCurrentRun(ctx, deps);
  if (!current) return;
  const config = await loadConfig(current.projectPaths);
  const evidence = await readEvidence(current.root, current.run);
  const report = await readResearchFile(current.root, current.run.paths.report);
  deps.dashboard.beginRun(`research-audit-${Date.now()}`);
  const progress = researchProgress(ctx, "Research audit");
  try {
    current.run.status = "auditing";
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    const independent = await performIndependentAudit(current.root, current.run, report, evidence, config.researchAuditModel, progress.update, deps.dashboard, undefined, `research-reaudit-${Date.now()}`);
    const audit = await auditPersistedResearch(current.root, current.run, evidence, report);
    const independentStatus = parseIndependentAuditStatus(independent);
    current.run.independentAuditStatus = independentStatus ?? "fail";
    if (!independentStatus) audit.issues.push({ severity: "critical", code: "AUDITOR_UNSTRUCTURED", message: "Independent auditor omitted its status marker." });
    else if (statusRank(independentStatus) > statusRank(audit.status)) audit.issues.push({ severity: independentStatus === "fail" ? "critical" : "warning", code: "INDEPENDENT_AUDIT", message: `Independent audit returned ${independentStatus.toUpperCase()}.` });
    recomputeAuditStatus(audit);
    current.run.auditStatus = audit.status;
    current.run.auditIssueCount = audit.issues.length;
    current.run.status = audit.status === "pass" ? "complete" : "complete-with-gaps";
    await writeResearchFile(current.root, current.run.paths.audit, formatResearchAudit(current.run, audit, independent));
    await writeResearchManifest(current.root, current.run, evidence);
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    deps.report("Research audit complete", `Status: **${audit.status.toUpperCase()}**\n\nIssues: ${audit.issues.length}\nAudit: ${current.run.paths.audit}`);
  } catch (error) {
    current.run.status = "blocked";
    current.run.auditStatus = "fail";
    current.run.independentAuditStatus = "fail";
    await saveResearchRun(current.projectPaths.stateDir, current.run);
    deps.report("Research operation failed", error instanceof Error ? error.message : String(error));
  } finally {
    deps.dashboard.endRun();
    progress.finish(current.run);
  }
}

async function mapConcurrent<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  }));
}

async function refreshCurrent(ctx: any, deps: ResearchRegistrationDependencies, includeAll: boolean): Promise<void> {
  if (!ctx.hasUI) return;
  const current = await requireCurrentRun(ctx, deps);
  if (!current) return;
  const evidence = await readEvidence(current.root, current.run);
  const candidates = evidence.filter((entry) => entry.sourceUrl && (includeAll || entry.volatile));
  if (!candidates.length) {
    deps.report("Nothing to refresh", includeAll ? "No evidence records have source URLs." : "No volatile evidence records have source URLs. Use `/research-refresh all` to check every URL.");
    return;
  }
  const confirmed = await ctx.ui.confirm("Refresh research sources?", `${candidates.length} source URL(s) will be fetched with concurrency 3. Claims will not be silently rewritten; changed fingerprints are marked needs-review.`);
  if (!confirmed) return;
  const progress = researchProgress(ctx, "Research refresh");
  let completed = 0;
  await mapConcurrent(candidates, 3, async (entry) => {
    try {
      const fetched = await retrieveResearchPage(deps, entry.sourceUrl!);
      await recordResearchPage(current.root, current.run, fetched);
      entry.lastCheckedAt = fetched.retrievedAt;
      entry.refreshError = undefined;
      if (!entry.contentHash) {
        entry.verificationStatus = "needs-review";
        entry.refreshStatus = "changed";
      } else if (entry.contentHash === fetched.contentHash) {
        entry.refreshStatus = "unchanged";
      } else {
        entry.refreshStatus = "changed";
        entry.verificationStatus = "needs-review";
        entry.notes = `${entry.notes ? `${entry.notes} | ` : ""}Source content fingerprint changed on ${fetched.retrievedAt}; review claim and excerpt before relying on it.`;
      }
    } catch (error) {
      entry.lastCheckedAt = ISO();
      entry.refreshStatus = "failed";
      entry.verificationStatus = "needs-review";
      entry.refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      completed++;
      progress.update(`${completed}/${candidates.length} checked`);
    }
  });
  await writeEvidence(current.root, current.run, evidence);
  const report = await readResearchFile(current.root, current.run.paths.report);
  const audit = await auditPersistedResearch(current.root, current.run, evidence, report);
  if (candidates.some((entry) => entry.refreshStatus === "changed")) {
    audit.issues.push({ severity: "warning", code: "SOURCE_CHANGED", message: "At least one source fingerprint changed; affected claims are marked needs-review." });
    recomputeAuditStatus(audit);
  }
  preserveResearchAuditAfterRefresh(current.run, audit);
  current.run.auditStatus = audit.status;
  current.run.auditIssueCount = audit.issues.length;
  current.run.status = audit.status === "pass" ? "complete" : "complete-with-gaps";
  await writeResearchFile(current.root, current.run.paths.audit, formatResearchAudit(current.run, audit, "Run /research-audit after reviewing changed sources for a new independent model audit."));
  await writeResearchManifest(current.root, current.run, evidence);
  await saveResearchRun(current.projectPaths.stateDir, current.run);
  const changed = candidates.filter((entry) => entry.refreshStatus === "changed").length;
  const failed = candidates.filter((entry) => entry.refreshStatus === "failed").length;
  deps.report("Research refresh complete", `Checked: ${candidates.length}\nChanged: ${changed}\nFailed: ${failed}\n\nEvidence: ${current.run.paths.evidence}\nAudit: ${current.run.paths.audit}`);
  progress.finish(current.run);
}

export function registerWorkbenchResearch(pi: ExtensionAPI, deps: ResearchRegistrationDependencies): void {
  pi.on("session_start", async (_event, ctx) => {
    const root = await findProjectRoot(ctx.cwd, deps.exec);
    const projectPaths = getProjectPaths(root);
    const run = await loadResearchRun(projectPaths.stateDir);
    if (run && ctx.hasUI) ctx.ui.setStatus("pi-workbench", `research: ${run.status} • ${run.evidenceCount} evidence • audit ${run.auditStatus ?? "pending"}`);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const root = await findProjectRoot(ctx.cwd, deps.exec);
    const run = await loadResearchRun(getProjectPaths(root).stateDir);
    if (!run) return;
    return { systemPrompt: `${event.systemPrompt}\n\n## Current Workbench Research State\n${formatResearchContext(run)}` };
  });

  pi.on("session_compact", async (_event, ctx) => {
    const root = await findProjectRoot(ctx.cwd, deps.exec);
    const run = await loadResearchRun(getProjectPaths(root).stateDir);
    if (run && ctx.hasUI) ctx.ui.notify("Workbench Research state remains available from its manifest, evidence ledger and report after compaction.", "info");
  });

  pi.registerCommand("research", {
    description: "Run observable parallel research with source fallback, evidence ledger, synthesis and independent audit",
    handler: async (args, ctx) => { await startResearch(pi, deps, ctx, { question: args.trim() || undefined }); },
  });

  pi.registerCommand("research-status", {
    description: "Show the current Workbench Research run, tracks, evidence and artifact paths",
    handler: async (_args, ctx) => {
      const current = await requireCurrentRun(ctx, deps);
      if (!current) return;
      const run = current.run;
      deps.report("Workbench Research status", `${formatResearchContext(run)}\n\n## Tracks\n${run.tracks.map((track) => `- ${track.status === "complete" ? "✓" : track.status === "failed" ? "✗" : "○"} **${track.title}** — ${track.status}${track.outputPath ? ` — ${track.outputPath}` : ""}`).join("\n")}\n\nSearch routes: ${(run.providerSummary ?? []).join(", ")}`);
    },
  });

  pi.registerCommand("research-source", {
    description: "Add and retrieve a source for the current evidence ledger",
    handler: async (args, ctx) => { await addSource(ctx, deps, args); },
  });

  pi.registerCommand("research-observation", {
    description: "Record a user-verified call, quote, site visit, photograph or measurement",
    handler: async (args, ctx) => { await addObservation(ctx, deps, args); },
  });

  pi.registerCommand("research-synthesize", {
    description: "Re-synthesize and re-audit the report after adding observations or sources",
    handler: async (_args, ctx) => { await synthesizeCurrent(ctx, deps); },
  });

  pi.registerCommand("research-audit", {
    description: "Re-run deterministic and independent model audits against the current report and evidence",
    handler: async (_args, ctx) => { await auditCurrent(ctx, deps); },
  });

  pi.registerCommand("research-refresh", {
    description: "Refresh volatile source fingerprints; pass 'all' to check every sourced record",
    handler: async (args, ctx) => { await refreshCurrent(ctx, deps, args.trim().toLowerCase() === "all"); },
  });

  pi.registerCommand("research-export", {
    description: "Refresh the current run manifest and show report/evidence/audit export paths",
    handler: async (_args, ctx) => {
      const current = await requireCurrentRun(ctx, deps);
      if (!current) return;
      const evidence = await readEvidence(current.root, current.run);
      await writeResearchManifest(current.root, current.run, evidence);
      deps.report("Research exports", `- Report: ${current.run.paths.report}\n- Evidence JSONL: ${current.run.paths.evidence}\n- Audit: ${current.run.paths.audit}\n- Manifest: ${current.run.paths.manifest}\n- Plan: ${current.run.paths.plan}\n\nUse these audited artifacts as inputs when asking Pi to update an XLSX, HTML artifact or decision document.`);
    },
  });

  pi.registerCommand("research-handoff", {
    description: "Create a focused new Pi session carrying the current research state",
    handler: async (args, ctx) => {
      const current = await requireCurrentRun(ctx, deps);
      if (!current) return;
      const next = args.trim() || "Continue from the audited findings and resolve the remaining evidence gaps.";
      const prompt = `## Research context\n${formatResearchContext(current.run)}\n\n## Next task\n${next}\n\nRead the report, evidence ledger and audit before making factual claims. Preserve evidence IDs and distinguish verified observations from web-derived claims.`;
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (fresh: any) => {
          fresh.ui.setEditorText(prompt);
          fresh.ui.notify("Research handoff ready. Review and submit.", "info");
        },
      });
    },
  });

  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description: "Start an interactive Workbench Research run with bounded parallel tracks, resilient public-web retrieval, a durable evidence ledger, cited synthesis and an independent audit.",
    promptSnippet: "Run decision-grade parallel research with provenance and audit",
    promptGuidelines: [
      "Use deep_research when the user asks for substantial external research, market research, current-source investigation, or a decision-grade evidence report; do not simulate background agents in the main context.",
      "deep_research requires user confirmation of scope and possible API usage before it runs.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Focused research question" }),
      mode: Type.Optional(StringEnum(["market", "technical", "general"] as const)),
      depth: Type.Optional(StringEnum(["fast", "decision-grade"] as const)),
      decision: Type.Optional(Type.String({ description: "Decision the evidence should support" })),
      geography: Type.Optional(Type.String({ description: "Geographic scope for market research" })),
      asOf: Type.Optional(Type.String({ description: "Evidence cutoff date, preferably YYYY-MM-DD" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await startResearch(pi, deps, ctx, params, signal);
      return {
        content: [{ type: "text", text: result.summary }],
        details: { run: result.run },
        terminate: true,
      };
    },
  });
}
