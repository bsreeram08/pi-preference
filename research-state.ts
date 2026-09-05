import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ResearchSource } from "./research-provenance.ts";
import type { WorkbenchConfig } from "./config.ts";
import type {
  EvidenceConfidence,
  EvidenceKind,
  ResearchAuditIssue,
  ResearchAuditResult,
  ResearchDepth,
  ResearchEvidence,
  ResearchMode,
  ResearchRun,
  ResearchTrack,
  SourceTier,
} from "./research-types.ts";

const KINDS = new Set<EvidenceKind>(["fact", "reported-claim", "inference", "recommendation"]);
const TIERS = new Set<SourceTier>(["primary", "official", "direct-platform", "secondary", "user-observation", "unknown"]);
const CONFIDENCES = new Set<EvidenceConfidence>(["high", "medium", "low"]);

export interface ResearchStatePaths {
  stateDir: string;
  current: string;
}

function iso(): string {
  return new Date().toISOString();
}

function projectRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "research";
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, filePath);
}

export function getResearchStatePaths(councilStateDir: string): ResearchStatePaths {
  const stateDir = path.join(councilStateDir, "research");
  return { stateDir, current: path.join(stateDir, "current.json") };
}

export async function loadResearchRun(councilStateDir: string): Promise<ResearchRun | undefined> {
  try {
    const content = await fs.readFile(getResearchStatePaths(councilStateDir).current, "utf8");
    const run = JSON.parse(content) as ResearchRun;
    if (run.version !== 1 || !run.id || !run.projectRoot || !run.paths?.runDir) return undefined;
    return run;
  } catch {
    return undefined;
  }
}

export async function saveResearchRun(councilStateDir: string, run: ResearchRun): Promise<void> {
  run.updatedAt = iso();
  await atomicWrite(getResearchStatePaths(councilStateDir).current, `${JSON.stringify(run, null, 2)}\n`);
}

export async function createResearchRun(
  root: string,
  councilStateDir: string,
  config: WorkbenchConfig,
  input: {
    question: string;
    decision: string;
    mode: ResearchMode;
    depth: ResearchDepth;
    geography?: string;
    asOf: string;
    tracks: ResearchTrack[];
    providerSummary: string[];
  },
): Promise<ResearchRun> {
  const createdAt = iso();
  const stamp = createdAt.replaceAll(":", "-").replaceAll(".", "-");
  const id = `${stamp}-${slug(input.question)}`;
  const absoluteRunDir = path.join(root, config.researchOutputDir, "runs", id);
  await fs.mkdir(path.join(absoluteRunDir, "tracks"), { recursive: true });
  const relativeRunDir = projectRelative(root, absoluteRunDir);
  const run: ResearchRun = {
    version: 1,
    id,
    projectRoot: root,
    question: input.question,
    decision: input.decision,
    mode: input.mode,
    depth: input.depth,
    ...(input.geography?.trim() ? { geography: input.geography.trim() } : {}),
    asOf: input.asOf,
    status: "planning",
    createdAt,
    updatedAt: createdAt,
    tracks: input.tracks,
    paths: {
      runDir: relativeRunDir,
      plan: `${relativeRunDir}/plan.md`,
      evidence: `${relativeRunDir}/evidence.jsonl`,
      report: `${relativeRunDir}/report.md`,
      audit: `${relativeRunDir}/audit.md`,
      manifest: `${relativeRunDir}/manifest.json`,
    },
    sourceTargetPerTrack: config.researchSourcesPerTrack,
    evidenceCount: 0,
    providerSummary: input.providerSummary,
  };
  await saveResearchRun(councilStateDir, run);
  await writeEvidence(root, run, []);
  return run;
}

export function resolveResearchPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Research path escapes the project root: ${relativePath}`);
  }
  return resolved;
}

export async function writeResearchFile(root: string, relativePath: string, content: string): Promise<void> {
  await atomicWrite(resolveResearchPath(root, relativePath), `${content.trimEnd()}\n`);
}

export async function readResearchFile(root: string, relativePath: string): Promise<string> {
  try { return await fs.readFile(resolveResearchPath(root, relativePath), "utf8"); } catch { return ""; }
}

export function canonicalizeResearchUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nextEvidenceNumber(existing: ResearchEvidence[]): number {
  return existing.reduce((max, item) => Math.max(max, Number(item.id.match(/^E-(\d+)$/)?.[1] ?? 0)), 0) + 1;
}

export function normalizeEvidence(
  raw: Partial<ResearchEvidence> & { claim?: string },
  run: ResearchRun,
  trackId: string,
  id: string,
  context: { sources?: Map<string, ResearchSource>; observation?: ResearchSource } = {},
): ResearchEvidence {
  const sourceUrl = stringValue(raw.sourceUrl);
  const sourceTier = TIERS.has(raw.sourceTier as SourceTier) ? raw.sourceTier as SourceTier : "unknown";
  const kind = KINDS.has(raw.kind as EvidenceKind) ? raw.kind as EvidenceKind : "reported-claim";
  const confidence = CONFIDENCES.has(raw.confidence as EvidenceConfidence) ? raw.confidence as EvidenceConfidence : "low";
  const source = context.observation ?? context.sources?.get(canonicalizeResearchUrl(sourceUrl) ?? "");
  const excerpt = stringValue(raw.excerpt);
  const supported = source && excerpt && source.record.text.replace(/\s+/g, " ").includes(excerpt.replace(/\s+/g, " "));
  const page = source?.record.page;
  const observation = source?.record.kind === "user-observation";
  const verificationStatus = supported ? observation ? "user-verified" : "web-retrieved" : "unverified";
  const geography = stringValue(raw.geography) ?? run.geography;
  return {
    id,
    runId: run.id,
    trackId,
    claim: stringValue(raw.claim) ?? "",
    kind,
    sourceTier: sourceTier === "user-observation" && !observation ? "unknown" : observation ? "user-observation" : sourceTier,
    confidence,
    verificationStatus,
    ...(sourceUrl ? { sourceUrl, canonicalUrl: canonicalizeResearchUrl(raw.canonicalUrl ?? sourceUrl) } : {}),
    ...(stringValue(raw.sourceTitle) ? { sourceTitle: stringValue(raw.sourceTitle) } : {}),
    ...(stringValue(raw.publisher) ? { publisher: stringValue(raw.publisher) } : {}),
    ...(stringValue(raw.publishedAt) ? { publishedAt: stringValue(raw.publishedAt) } : {}),
    retrievedAt: source?.record.recordedAt ?? "",
    ...(stringValue(raw.observedAt) ? { observedAt: stringValue(raw.observedAt) } : {}),
    ...(stringValue(raw.excerpt) ? { excerpt: stringValue(raw.excerpt) } : {}),
    ...(geography ? { geography } : {}),
    volatile: Boolean(raw.volatile),
    ...(page ? { contentHash: page.contentHash, sourceTitle: page.title, publisher: page.publisher, publishedAt: page.publishedAt, canonicalUrl: canonicalizeResearchUrl(page.canonicalUrl ?? page.finalUrl) } : {}),
    ...(supported ? { provenance: source.provenance, ...(observation ? { observedAt: source.record.observedAt } : {}) } : {}),
    ...(Array.isArray(raw.conflictsWith) ? { conflictsWith: raw.conflictsWith.filter((value): value is string => typeof value === "string") } : {}),
    ...(stringValue(raw.notes) ? { notes: stringValue(raw.notes) } : {}),
    ...(stringValue(raw.lastCheckedAt) ? { lastCheckedAt: stringValue(raw.lastCheckedAt) } : {}),
    ...(raw.refreshStatus ? { refreshStatus: raw.refreshStatus } : {}),
    ...(stringValue(raw.refreshError) ? { refreshError: stringValue(raw.refreshError) } : {}),
  };
}

export function mergeEvidence(
  existing: ResearchEvidence[],
  incoming: Array<Partial<ResearchEvidence> & { claim?: string }>,
  run: ResearchRun,
  trackId: string,
  context: { sources?: Map<string, ResearchSource>; observation?: ResearchSource } = {},
): ResearchEvidence[] {
  const merged = existing.map((entry) => ({ ...entry }));
  if (incoming.length > 100) throw new Error("A research track exceeds 100 evidence records.");
  let sequence = nextEvidenceNumber(merged);
  for (const raw of incoming) {
    const candidate = normalizeEvidence(raw, run, trackId, `E-${String(sequence).padStart(3, "0")}`, context);
    const duplicate = merged.find((item) =>
      item.claim.trim().toLowerCase() === candidate.claim.trim().toLowerCase()
      && (item.canonicalUrl ?? "") === (candidate.canonicalUrl ?? ""),
    );
    if (duplicate) {
      if (!duplicate.excerpt && candidate.excerpt) duplicate.excerpt = candidate.excerpt;
      if (!duplicate.contentHash && candidate.contentHash) duplicate.contentHash = candidate.contentHash;
      if ((trackId === "manual-source" || trackId === "user-observation") && candidate.provenance && candidate.verificationStatus !== "unverified") {
        duplicate.provenance = candidate.provenance;
        duplicate.sourceUrl = candidate.sourceUrl;
        duplicate.sourceTitle = candidate.sourceTitle;
        duplicate.publisher = candidate.publisher;
        duplicate.publishedAt = candidate.publishedAt;
        duplicate.canonicalUrl = candidate.canonicalUrl;
        duplicate.contentHash = candidate.contentHash;
        duplicate.excerpt = candidate.excerpt;
        duplicate.retrievedAt = candidate.retrievedAt;
        duplicate.lastCheckedAt = candidate.retrievedAt;
        duplicate.verificationStatus = candidate.verificationStatus;
        duplicate.sourceTier = candidate.sourceTier;
        duplicate.observedAt = candidate.observedAt;
        duplicate.refreshStatus = "baseline-established";
        duplicate.refreshError = undefined;
        duplicate.notes = `${duplicate.notes ? `${duplicate.notes} | ` : ""}Changed source manually reviewed and re-baselined on ${candidate.retrievedAt}.`;
      }
      if (duplicate.confidence === "low" && candidate.confidence !== "low") duplicate.confidence = candidate.confidence;
      continue;
    }
    merged.push(candidate);
    sequence++;
  }
  return merged;
}

export function mergeResearchTrack(
  existing: ResearchEvidence[], incoming: Array<Partial<ResearchEvidence>>, run: ResearchRun, trackId: string,
  findings: string, openQuestions: string, sources: Map<string, ResearchSource>,
): { evidence: ResearchEvidence[]; findings: string; openQuestions: string } {
  if (incoming.length > 100) throw new Error("A research track exceeds 100 evidence records.");
  let evidence = existing;
  const mapping = new Map<string, string>();
  const introduced = new Set<string>();
  incoming.forEach((raw, index) => {
    const normalized = normalizeEvidence(raw, run, trackId, "candidate", { sources });
    const before = new Set(evidence.map((entry) => entry.id));
    evidence = mergeEvidence(evidence, [raw], run, trackId, { sources });
    const match = evidence.find((entry) => entry.claim.toLowerCase() === normalized.claim.toLowerCase() && (entry.canonicalUrl ?? "") === (normalized.canonicalUrl ?? ""));
    if (!match) throw new Error("Could not resolve track evidence ID.");
    mapping.set(`T${index + 1}`, match.id);
    if (!before.has(match.id)) introduced.add(match.id);
  });
  const rewrite = (text: string) => text.replace(/\bT\d+\b/g, (id) => mapping.get(id) ?? id);
  for (const entry of evidence) if (introduced.has(entry.id)) entry.conflictsWith = entry.conflictsWith?.map(rewrite);
  return { evidence, findings: rewrite(findings), openQuestions: rewrite(openQuestions) };
}

export async function readEvidence(root: string, run: ResearchRun): Promise<ResearchEvidence[]> {
  const content = await fs.readFile(resolveResearchPath(root, run.paths.evidence), "utf8");
  const evidence: ResearchEvidence[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as ResearchEvidence;
    if (!parsed || typeof parsed.claim !== "string" || typeof parsed.id !== "string" || parsed.runId !== run.id || !KINDS.has(parsed.kind) || !TIERS.has(parsed.sourceTier)) throw new Error("Invalid research evidence record.");
    evidence.push(parsed);
  }
  return evidence;
}

export async function writeEvidence(root: string, run: ResearchRun, evidence: ResearchEvidence[]): Promise<void> {
  const content = evidence.map((entry) => JSON.stringify(entry)).join("\n");
  await atomicWrite(resolveResearchPath(root, run.paths.evidence), content ? `${content}\n` : "");
  run.evidenceCount = evidence.length;
}

function sourceDomain(url: string | undefined): string | undefined {
  try { return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : undefined; } catch { return undefined; }
}

/** Bibliography references do not count as support for report-body claims. */
export function researchReportBody(report: string): string {
  let bibliography = false;
  const lines: string[] = [];
  for (const line of report.split("\n")) {
    if (/^#{1,6}\s/.test(line)) bibliography = /^#{1,6}\s+(?:(?:canonical )?evidence index|sources(?: and evidence index)?|references|bibliography)\s*$/i.test(line.trim());
    if (!bibliography && !/^>/.test(line)) lines.push(line);
  }
  return lines.join("\n");
}

export function preserveResearchAuditAfterRefresh(run: ResearchRun, audit: ResearchAuditResult): void {
  audit.issues.push({ severity: run.independentAuditStatus === "fail" || run.auditStatus === "fail" ? "critical" : "warning", code: "REAUDIT_REQUIRED", message: "Refreshing sources does not resolve prior findings. Review affected claims and run /research-audit." });
  audit.status = audit.issues.some((issue) => issue.severity === "critical") ? "fail" : "warning";
}

export function auditResearchEvidence(
  run: ResearchRun,
  evidence: ResearchEvidence[],
  report = "",
): ResearchAuditResult {
  const issues: ResearchAuditIssue[] = [];
  const ids = new Set(evidence.map((entry) => entry.id));
  const domains = new Set(evidence.map((entry) => sourceDomain(entry.canonicalUrl ?? entry.sourceUrl)).filter((value): value is string => Boolean(value)));
  if (evidence.length === 0) issues.push({ severity: "critical", code: "NO_EVIDENCE", message: "The run produced no structured evidence." });

  if (!researchReportBody(report).trim()) issues.push({ severity: "critical", code: "EMPTY_REPORT", message: "No report body was produced." });
  if (ids.size !== evidence.length) issues.push({ severity: "critical", code: "DUPLICATE_IDS", message: "Evidence IDs must be unique." });
  const duplicateKeys = new Set<string>();
  for (const entry of evidence) {
    if (!entry.claim.trim()) issues.push({ severity: "critical", code: "EMPTY_CLAIM", message: "Evidence has no claim text.", evidenceId: entry.id });
    const externallyReported = entry.kind === "fact" || entry.kind === "reported-claim";
    if (externallyReported && (!entry.provenance || !["web-retrieved", "user-verified"].includes(entry.verificationStatus))) issues.push({ severity: "critical", code: "UNBOUND_EVIDENCE", message: "Factual evidence needs a recorded source and matching excerpt.", evidenceId: entry.id });
    if (entry.verificationStatus === "needs-review" || entry.refreshStatus === "changed" || entry.refreshStatus === "failed") issues.push({ severity: "critical", code: "UNRESOLVED_SOURCE", message: "Source review or retrieval failure remains unresolved.", evidenceId: entry.id });
    if (entry.sourceTier === "user-observation" && entry.provenance?.kind !== "user-observation") issues.push({ severity: "critical", code: "UNBOUND_OBSERVATION", message: "User verification requires a recorded user submission.", evidenceId: entry.id });

    if (externallyReported && entry.sourceTier !== "user-observation" && !entry.sourceUrl) {
      issues.push({ severity: "critical", code: "MISSING_SOURCE", message: "A factual/reported claim has no source URL.", evidenceId: entry.id });
    }
    if (entry.sourceUrl && !canonicalizeResearchUrl(entry.sourceUrl)) {
      issues.push({ severity: "critical", code: "INVALID_SOURCE_URL", message: "Evidence has an invalid source URL.", evidenceId: entry.id });
    }
    if (externallyReported && !entry.excerpt) {
      issues.push({ severity: "warning", code: "MISSING_EXCERPT", message: "A factual/reported claim has no supporting excerpt.", evidenceId: entry.id });
    }
    if (externallyReported && entry.sourceTier === "unknown") issues.push({ severity: "warning", code: "UNKNOWN_TIER", message: "Source tier is unknown for a factual/reported claim.", evidenceId: entry.id });
    if (entry.volatile && !entry.retrievedAt) issues.push({ severity: "critical", code: "VOLATILE_WITHOUT_DATE", message: "Volatile evidence lacks a retrieval date.", evidenceId: entry.id });
    if (entry.sourceTier === "user-observation" && !entry.observedAt) issues.push({ severity: "warning", code: "OBSERVATION_WITHOUT_DATE", message: "User observation lacks an observation date.", evidenceId: entry.id });
    for (const conflict of entry.conflictsWith ?? []) {
      if (!ids.has(conflict)) issues.push({ severity: "warning", code: "UNKNOWN_CONFLICT", message: `Conflict reference ${conflict} does not exist.`, evidenceId: entry.id });
    }
    const key = `${entry.claim.trim().toLowerCase()}|${entry.canonicalUrl ?? ""}`;
    if (duplicateKeys.has(key)) issues.push({ severity: "suggestion", code: "DUPLICATE_EVIDENCE", message: "Duplicate claim/source pair.", evidenceId: entry.id });
    duplicateKeys.add(key);
  }

  const body = researchReportBody(report);
  const references = new Set([...body.matchAll(/\[(E-\d+)\]/g)].map((match) => match[1]));
  for (const reference of references) {
    if (!ids.has(reference)) issues.push({ severity: "critical", code: "UNKNOWN_CITATION", message: `Report cites missing evidence ${reference}.` });
  }
  const hasQuantities = (text: string) => /(?:[₹$€£]\s*\d|\d[\d.,]*\s*%|\b\d{2,}(?:[.,]\d+)?\b)/.test(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
  if (body && hasQuantities(body) && references.size === 0) {
    issues.push({ severity: "critical", code: "NUMBERS_WITHOUT_EVIDENCE_IDS", message: "The report contains material numeric claims but no [E-###] evidence references." });
  }
  if (/\bT\d+\b/.test(body)) issues.push({ severity: "critical", code: "UNRESOLVED_CITATION", message: "Report contains unresolved temporary evidence IDs." });
  for (const paragraph of body.split(/\n\s*\n/)) {
    if (hasQuantities(paragraph) && !/\[E-\d+\]/.test(paragraph)) {
      issues.push({ severity: "critical", code: "UNCITED_NUMERIC_CLAIM", message: "A numeric report passage has no inline evidence citation." });
    }
  }
  if (run.depth === "decision-grade" && domains.size < 2) {
    issues.push({ severity: "warning", code: "LOW_SOURCE_DIVERSITY", message: `Decision-grade research uses only ${domains.size} distinct web source domain(s).` });
  }
  const successfulTracks = run.tracks.filter((track) => track.status === "complete").length;
  if (successfulTracks === 0) issues.push({ severity: "critical", code: "NO_COMPLETED_TRACKS", message: "No research track completed successfully." });
  if (run.tracks.some((track) => track.status === "failed")) issues.push({ severity: "warning", code: "FAILED_TRACK", message: "At least one research track failed; inspect the track report." });

  const status = issues.some((issue) => issue.severity === "critical")
    ? "fail"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "pass";
  return { status, issues, evidenceCount: evidence.length, citedEvidenceCount: references.size, sourceDomainCount: domains.size };
}

export function formatResearchAudit(run: ResearchRun, result: ResearchAuditResult, independentAudit = ""): string {
  const grouped = (severity: ResearchAuditIssue["severity"]) => result.issues.filter((issue) => issue.severity === severity);
  const lines = [
    `# Research Audit`,
    ``,
    `- **Run:** ${run.id}`,
    `- **Status:** ${result.status.toUpperCase()}`,
    `- **Evidence records:** ${result.evidenceCount}`,
    `- **Evidence IDs cited in report:** ${result.citedEvidenceCount}`,
    `- **Distinct web domains:** ${result.sourceDomainCount}`,
    `- **Audited:** ${iso()}`,
  ];
  for (const severity of ["critical", "warning", "suggestion"] as const) {
    const items = grouped(severity);
    lines.push(``, `## ${severity[0].toUpperCase()}${severity.slice(1)} (${items.length})`);
    if (!items.length) lines.push(`- None.`);
    else for (const issue of items) lines.push(`- **${issue.code}**${issue.evidenceId ? ` (${issue.evidenceId})` : ""}: ${issue.message}`);
  }
  if (independentAudit.trim()) lines.push(``, `## Independent model review`, ``, independentAudit.trim());
  return `${lines.join("\n")}\n`;
}

export function formatResearchContext(run: ResearchRun): string {
  const complete = run.tracks.filter((track) => track.status === "complete").length;
  const failed = run.tracks.filter((track) => track.status === "failed").length;
  return [
    `Active Workbench Research run: ${run.id}`,
    `Question: ${run.question}`,
    `Decision: ${run.decision}`,
    `Mode/depth: ${run.mode}/${run.depth}; as of ${run.asOf}${run.geography ? `; geography: ${run.geography}` : ""}`,
    `Status: ${run.status}; tracks ${complete}/${run.tracks.length} complete${failed ? `, ${failed} failed` : ""}; evidence ${run.evidenceCount}; audit ${run.auditStatus ?? "pending"}`,
    `Report: ${run.paths.report}`,
    `Evidence: ${run.paths.evidence}`,
    `Audit: ${run.paths.audit}`,
    `Treat report facts as provisional when the audit is warning/fail; preserve evidence IDs and retrieval dates.`,
  ].join("\n");
}

export async function writeResearchManifest(root: string, run: ResearchRun, evidence: ResearchEvidence[]): Promise<void> {
  const domains = [...new Set(evidence.map((entry) => sourceDomain(entry.canonicalUrl ?? entry.sourceUrl)).filter(Boolean))].sort();
  const manifest = {
    schemaVersion: 1,
    generatedAt: iso(),
    run,
    summary: {
      evidenceRecords: evidence.length,
      sourceDomains: domains,
      completedTracks: run.tracks.filter((track) => track.status === "complete").length,
      failedTracks: run.tracks.filter((track) => track.status === "failed").length,
    },
  };
  await writeResearchFile(root, run.paths.manifest, JSON.stringify(manifest, null, 2));
}
