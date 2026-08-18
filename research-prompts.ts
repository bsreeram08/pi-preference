import type { AgentSpec } from "./types.ts";
import type { ParsedResearchAgentOutput, ResearchDepth, ResearchEvidence, ResearchMode, ResearchRun, ResearchTrack } from "./research-types.ts";

interface TrackTemplate {
  id: string;
  title: string;
  scope: string;
  preferredSources: string;
  description: string;
}

const MARKET_TRACKS: TrackTemplate[] = [
  {
    id: "competition-pricing",
    title: "Competition and pricing",
    scope: "Identify direct and adjacent competitors, current prices, formats, customer signals, and distance/catchment evidence. Distinguish board-game businesses from electronic-gaming analogues.",
    preferredSources: "Official venue sites, direct social posts, current Maps/place pages, current menus or booking pages; secondary guides only when dated and labelled.",
    description: "Local-market investigator focused on competitors, current pricing, and customer-facing positioning.",
  },
  {
    id: "location-demand",
    title: "Catchment and demand anchors",
    scope: "Investigate local demand anchors, access, institutions, employment/student catchments, transport and realistic demand proxies without converting proxies into customer-volume claims.",
    preferredSources: "Government, institution and employer sites; transport authorities; current maps; clearly dated demographic sources.",
    description: "Location researcher who separates catchment facts from unproven demand assumptions.",
  },
  {
    id: "property-market",
    title: "Commercial property market",
    scope: "Find current commercial rent leads and comparable occupancy costs. Capture direct-page rent, maintenance, deposit, area, floor, washrooms, parking, availability language and discrepancies.",
    preferredSources: "Direct listing pages and broker/owner pages; portal search cards only as discovery. Every listing is volatile and unverified until called.",
    description: "Commercial-property researcher focused on comparable, decision-useful listing evidence and verification risks.",
  },
  {
    id: "quantitative-economics",
    title: "Quantitative and capacity analysis",
    scope: "Translate credible evidence into unit economics, capacity, area and scenario implications. Recalculate arithmetic and identify which inputs remain assumptions.",
    preferredSources: "The project's existing model and primary/official source evidence collected for costs, prices and capacity constraints.",
    description: "Quantitative analyst who checks units, arithmetic, sensitivity and model-to-evidence alignment.",
  },
  {
    id: "skeptic-gaps",
    title: "Skeptic and evidence gaps",
    scope: "Search for contrary evidence, stale or missing data, selection bias, regulatory/operational unknowns and reasons the apparent opportunity may not transfer to the target market.",
    preferredSources: "Primary regulations and official guidance where relevant, contradictory direct evidence, and the strongest credible counterexamples.",
    description: "Adversarial research reviewer who looks for disconfirming evidence and fieldwork requirements.",
  },
];

const TECHNICAL_TRACKS: TrackTemplate[] = [
  {
    id: "official-docs-specs",
    title: "Official documentation and specifications",
    scope: "Establish the authoritative current behavior, version, terminology, limits and guarantees from the source owner.",
    preferredSources: "Official documentation, standards, specifications, release notes and first-party API references.",
    description: "Primary-source technical documentation researcher.",
  },
  {
    id: "source-implementation",
    title: "Source code and implementation",
    scope: "Inspect upstream source and tests for actual behavior, edge cases and implementation constraints that documentation may omit.",
    preferredSources: "Official source repositories, tagged source, tests and maintainers' issue trackers.",
    description: "Upstream source-code investigator who verifies documentation against implementation.",
  },
  {
    id: "versions-compatibility",
    title: "Versions, compatibility and deprecation",
    scope: "Map relevant versions, dates, compatibility matrices, migrations, deprecations and known breaking changes.",
    preferredSources: "Official release notes, support policies, package registries and migration guides.",
    description: "Compatibility researcher focused on current versions and change history.",
  },
  {
    id: "examples-edge-cases",
    title: "Examples and edge cases",
    scope: "Find first-party examples and tests, then identify failure modes, unsupported combinations and operational caveats.",
    preferredSources: "Official examples, conformance tests, source tests and maintainer-authored guidance.",
    description: "Technical examples and edge-case investigator.",
  },
  {
    id: "skeptic-security",
    title: "Skeptic, security and unresolved gaps",
    scope: "Challenge the proposed interpretation, find security/reliability concerns and identify claims not supported by authoritative evidence.",
    preferredSources: "Security advisories, official issue trackers, specifications and contradictory upstream evidence.",
    description: "Adversarial technical reviewer focused on unsupported claims, security and reliability.",
  },
];

const GENERAL_TRACKS: TrackTemplate[] = [
  {
    id: "primary-sources",
    title: "Primary-source facts",
    scope: "Establish the core facts needed for the decision and follow each material claim to the source that owns it.",
    preferredSources: "Official records, first-party publications, original datasets and direct statements.",
    description: "General primary-source investigator.",
  },
  {
    id: "alternatives-comparables",
    title: "Alternatives and comparables",
    scope: "Identify realistic alternatives, precedents and comparable cases, including important differences that limit transferability.",
    preferredSources: "First-party case material and clearly dated, methodologically transparent comparisons.",
    description: "Comparative researcher focused on alternatives and transferability.",
  },
  {
    id: "quantitative",
    title: "Quantitative evidence",
    scope: "Find and validate measurable evidence, recalculate reported figures and expose assumptions or denominator errors.",
    preferredSources: "Original datasets, official statistics and transparent first-party calculations.",
    description: "Quantitative evidence analyst.",
  },
  {
    id: "implementation-reality",
    title: "Execution reality",
    scope: "Investigate practical implementation requirements, constraints, costs, timelines and dependencies.",
    preferredSources: "Official requirements, direct provider documentation, current quotes and first-party operational evidence.",
    description: "Execution researcher focused on practical constraints and dependencies.",
  },
  {
    id: "skeptic",
    title: "Contrary evidence and gaps",
    scope: "Find the strongest contrary evidence, unresolved uncertainty, bias and conditions that would reverse the recommendation.",
    preferredSources: "Credible counterevidence and the same source tiers used by supporting tracks.",
    description: "Adversarial general-research reviewer.",
  },
];

export function detectResearchMode(question: string): ResearchMode {
  const lower = question.toLowerCase();
  if (/\b(api|sdk|library|framework|documentation|docs|specification|source code|version|release|lts|runtime|dependency|package|migration|protocol|technical|node\.js)\b/.test(lower)) return "technical";
  if (/\b(market|business|competitor|pricing|price|rent|property|customer|location|cafe|restaurant|commercial|demand|revenue|profit)\b/.test(lower)) return "market";
  return "general";
}

export function createResearchTracks(mode: ResearchMode, depth: ResearchDepth, maxAgents: number): ResearchTrack[] {
  const templates = mode === "market" ? MARKET_TRACKS : mode === "technical" ? TECHNICAL_TRACKS : GENERAL_TRACKS;
  const count = Math.min(depth === "fast" ? 3 : 5, Math.max(3, maxAgents), templates.length);
  return templates.slice(0, count).map((track) => ({
    id: track.id,
    title: track.title,
    scope: track.scope,
    preferredSources: track.preferredSources,
    status: "queued",
  }));
}

export function researchAgentForTrack(track: ResearchTrack, model: string | null): AgentSpec {
  const templates = [...MARKET_TRACKS, ...TECHNICAL_TRACKS, ...GENERAL_TRACKS];
  const template = templates.find((candidate) => candidate.id === track.id);
  return {
    id: `research-${track.id}`,
    title: track.title,
    description: template?.description ?? track.scope,
    triggers: [],
    readOnly: true,
    researchTools: true,
    ...(model ? { model } : {}),
  };
}

export function buildResearchPlan(run: ResearchRun): string {
  return `# Research Plan

- **Question:** ${run.question}
- **Decision supported:** ${run.decision}
- **Mode:** ${run.mode}
- **Depth:** ${run.depth}
- **As of:** ${run.asOf}
${run.geography ? `- **Geography:** ${run.geography}\n` : ""}- **Target sources per track:** ${run.sourceTargetPerTrack}
- **Search routes:** ${(run.providerSummary ?? []).join(", ")}

## Evidence rules

1. Prefer primary/official sources and inspect source pages rather than citing search snippets.
2. Separate fact, reported claim, inference and recommendation.
3. Every material numeric/current claim needs a source URL, exact excerpt and retrieval date.
4. Mark listings, prices, ratings and availability as volatile and unverified unless directly confirmed by the user.
5. Record conflicts instead of silently choosing a convenient value.

## Tracks

${run.tracks.map((track, index) => `### ${index + 1}. ${track.title}\n\n${track.scope}\n\n**Preferred sources:** ${track.preferredSources}`).join("\n\n")}
`;
}

export function buildResearchSystemPrompt(track: ResearchTrack): string {
  return `You are the Workbench Research specialist for **${track.title}**.

You are read-only. Do not write, edit, delete or commit project files. Use research_search for discovery, then inspect the actual source with research_fetch. Use research_browser only for JavaScript-dependent pages that static fetch cannot extract. Use qmd_search and repository reads when project knowledge affects the answer.

Evidence discipline:
- Primary: original law/specification/dataset/source owner.
- Official: first-party organization documentation or announcement.
- Direct-platform: current Maps, social post, booking page, menu or commercial listing supplied by the platform/owner; volatile and not independently verified.
- Secondary: a third-party article or aggregation; label date and transferability limits.
- User-observation: supplied call, visit, quote, photograph or measurement.
- Search snippets are discovery evidence, not sufficient support for a material claim.
- Do not turn “not surfaced in this search” into “does not exist.”
- Do not infer demand, revenue or causation from ratings, review counts, population or proximity.
- Keep exact units and dates. Recalculate arithmetic.
- Respect blocked pages and access restrictions; report the gap rather than bypassing controls.

Return the marker sections exactly. The JSON must be a valid array with no comments or Markdown fences.

=== FINDINGS ===
Concise Markdown findings for your assigned scope. Cite evidence IDs as temporary labels T1, T2, etc.; the parent will replace them with canonical E-### IDs.

=== EVIDENCE JSON ===
[
  {
    "claim": "One atomic, decision-relevant claim",
    "kind": "fact|reported-claim|inference|recommendation",
    "sourceTier": "primary|official|direct-platform|secondary|user-observation|unknown",
    "confidence": "high|medium|low",
    "verificationStatus": "web-retrieved|user-verified|unverified|needs-review",
    "sourceUrl": "https://... when applicable",
    "canonicalUrl": "https://... when available",
    "sourceTitle": "...",
    "publisher": "...",
    "publishedAt": "date when available",
    "retrievedAt": "ISO timestamp from the tool",
    "excerpt": "Exact short source text supporting the claim",
    "geography": "when relevant",
    "volatile": true,
    "contentHash": "SHA-256 from research_fetch/browser when available",
    "conflictsWith": [],
    "notes": "limitations or required verification"
  }
]

=== OPEN QUESTIONS ===
Unknowns, blocked sources, conflicting evidence and field verification required.
`;
}

export function buildResearchTrackTask(run: ResearchRun, track: ResearchTrack, qmdContext: string): string {
  return `Conduct one bounded research track.

QUESTION:
${run.question}

DECISION THIS MUST INFORM:
${run.decision}

MODE / DEPTH / AS-OF:
${run.mode} / ${run.depth} / ${run.asOf}

GEOGRAPHY:
${run.geography ?? "Not geographically constrained."}

YOUR TRACK:
${track.title}
${track.scope}

PREFERRED SOURCES:
${track.preferredSources}

PROJECT KNOWLEDGE:
${qmdContext || "No indexed project knowledge was available."}

Find approximately ${run.sourceTargetPerTrack} useful sources, but prioritize authority and relevance over count. Use multiple focused searches, inspect the source pages, and retain retrieval metadata. Stay within this track so parallel agents do not duplicate one another. Return only the required marker sections.`;
}

function extractMarked(output: string, start: string, end?: string): string | undefined {
  const from = output.indexOf(start);
  if (from < 0) return undefined;
  const bodyStart = from + start.length;
  const to = end ? output.indexOf(end, bodyStart) : output.length;
  if (to < bodyStart) return undefined;
  return output.slice(bodyStart, to).trim();
}

export function parseResearchAgentOutput(output: string): ParsedResearchAgentOutput {
  const findings = extractMarked(output, "=== FINDINGS ===", "=== EVIDENCE JSON ===");
  const evidenceText = extractMarked(output, "=== EVIDENCE JSON ===", "=== OPEN QUESTIONS ===");
  const openQuestions = extractMarked(output, "=== OPEN QUESTIONS ===") ?? "";
  if (findings === undefined || evidenceText === undefined) {
    return { findings: output.trim(), evidence: [], openQuestions, parseWarning: "Agent omitted required research markers." };
  }
  try {
    const cleaned = evidenceText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Evidence JSON is not an array");
    return { findings, evidence: parsed as ParsedResearchAgentOutput["evidence"], openQuestions };
  } catch (error) {
    return {
      findings,
      evidence: [],
      openQuestions,
      parseWarning: `Evidence JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function truncateForPrompt(value: string, max = 22_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n\n[Track text truncated for synthesis; full track file remains on disk.]`;
}

export function buildResearchSynthesisTask(run: ResearchRun, trackReports: string, evidence: ResearchEvidence[]): string {
  const evidenceJson = JSON.stringify(evidence.slice(0, 250), null, 2);
  return `Synthesize a decision-grade research report. Do not perform new research and do not invent missing evidence.

QUESTION:
${run.question}

DECISION:
${run.decision}

SCOPE:
Mode ${run.mode}; depth ${run.depth}; as of ${run.asOf}; geography ${run.geography ?? "not constrained"}.

TRACK REPORTS:
${truncateForPrompt(trackReports, 70_000)}

CANONICAL EVIDENCE LEDGER:
${truncateForPrompt(evidenceJson, 70_000)}

Rules:
1. Cite every material current/numeric factual claim inline using canonical IDs like [E-001].
2. Never cite a missing evidence ID.
3. Clearly separate observed/reported facts, analysis/inference, recommendations and unknowns.
4. Explain conflicts instead of silently resolving them.
5. Label volatile prices/listings/ratings as retrieved on the run date and requiring confirmation.
6. State what evidence would change the recommendation.
7. Do not claim field verification, phone confirmation or source completeness unless evidence says so.

Return only a complete Markdown report with:
# [Descriptive title]
## Executive answer
## Decision context and scope
## Findings
## Quantitative implications (when applicable)
## Conflicts and evidence quality
## Recommendation
## Unknowns and field verification
## Sources and evidence index
`;
}

export function buildResearchAuditTask(run: ResearchRun, report: string, evidence: ResearchEvidence[]): string {
  return `Independently audit this research report against its evidence ledger. You are read-only and must not repair the report. Check unsupported claims, wrong or missing evidence IDs, source-tier inflation, stale/current ambiguity, conflict suppression, arithmetic, geographic transfer, and whether recommendations are mislabeled as facts. Use research_fetch to spot-check every decision-critical numeric or volatile claim and a risk-based sample of other factual claims against the actual source page. Use research_browser only when a JavaScript shell prevents static verification. Treat inaccessible sources and excerpt mismatches as audit gaps; never assume the ledger is correct merely because it is structured.

RUN:
${JSON.stringify({ question: run.question, decision: run.decision, mode: run.mode, depth: run.depth, asOf: run.asOf, geography: run.geography }, null, 2)}

REPORT:
${truncateForPrompt(report, 70_000)}

EVIDENCE:
${truncateForPrompt(JSON.stringify(evidence.slice(0, 250), null, 2), 70_000)}

Return concise Markdown with:
## Verdict
PASS, WARNING, or FAIL.
## Unsupported or overstated claims
## Citation and provenance defects
## Numerical or logical defects
## Required corrections or field verification

End with exactly one marker: <research-audit status="pass"/>, <research-audit status="warning"/>, or <research-audit status="fail"/>.`;
}

export function parseIndependentAuditStatus(output: string): "pass" | "warning" | "fail" | undefined {
  return output.match(/<research-audit\s+status=["'](pass|warning|fail)["']\s*\/>/i)?.[1].toLowerCase() as "pass" | "warning" | "fail" | undefined;
}

export function formatEvidenceIndex(evidence: ResearchEvidence[]): string {
  if (!evidence.length) return "## Evidence index\n\nNo structured evidence was produced.\n";
  const lines = ["## Canonical evidence index", ""];
  for (const entry of evidence) {
    let fallbackLabel = "source";
    try { fallbackLabel = entry.sourceUrl ? new URL(entry.sourceUrl).hostname : fallbackLabel; } catch { /* audit will flag malformed provenance */ }
    const source = entry.sourceUrl
      ? `[${entry.sourceTitle ?? entry.publisher ?? fallbackLabel}](${entry.sourceUrl})`
      : entry.sourceTier === "user-observation" ? "User observation" : "No source URL";
    lines.push(`- **[${entry.id}]** ${entry.claim} — ${source}; ${entry.sourceTier}; retrieved ${entry.retrievedAt}${entry.volatile ? "; **volatile—reconfirm**" : ""}.`);
  }
  return `${lines.join("\n")}\n`;
}
