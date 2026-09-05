import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "../config.ts";
import { auditPersistedResearch, collectResearchSources, recordResearchPage, recordUserObservation } from "../research-provenance.ts";
import { auditResearchEvidence, createResearchRun, mergeEvidence, mergeResearchTrack, normalizeEvidence, preserveResearchAuditAfterRefresh, readEvidence, writeResearchFile } from "../research-state.ts";
import { buildResearchAnalysisTask, buildResearchAuditTask, createResearchTracks, formatEvidenceIndex, parseIndependentAuditStatus, parseResearchAgentOutput } from "../research-prompts.ts";
import type { ResearchFetchedPage } from "../research-tools.ts";
import type { ResearchEvidence } from "../research-types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const raw: Partial<ResearchEvidence> = { claim: "The rate is 99 dollars.", kind: "fact", sourceTier: "official", sourceUrl: "https://example.com/price", excerpt: "The rate is 99 dollars.", verificationStatus: "user-verified", retrievedAt: "invented", contentHash: "invented" };
function page(text = raw.excerpt!): ResearchFetchedPage {
  return { requestedUrl: raw.sourceUrl!, finalUrl: raw.sourceUrl!, title: "Official rates", text, contentHash: createHash("sha256").update(text).digest("hex"), contentType: "text/html", retrievedAt: "2026-09-05T00:00:00.000Z", truncated: false };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-provenance-")); roots.push(root);
  const tracks = createResearchTracks("general", "fast", 3); tracks.forEach((track) => track.status = "complete");
  const run = await createResearchRun(root, path.join(root, ".pi/pi-workbench"), DEFAULT_CONFIG, { question: "Price?", decision: "Choose a price", mode: "general", depth: "fast", asOf: "2026-09-05", tracks, providerSummary: [] });
  const sources = await collectResearchSources(root, run, [raw], async () => page());
  const evidence = mergeEvidence([], [raw], run, "primary", { sources });
  return { root, run, sources, evidence };
}

describe("recorded research provenance and audit gates", () => {
  test("binds actual retrieval metadata and excerpt, ignores model provenance", async () => {
    const { root, run, evidence } = await fixture();
    expect(evidence[0].verificationStatus).toBe("web-retrieved");
    expect(evidence[0].retrievedAt).toBe(page().retrievedAt);
    expect(evidence[0].contentHash).toBe(page().contentHash);
    expect((await auditPersistedResearch(root, run, evidence, "The rate is 99 dollars [E-001].")).status).toBe("pass");
    const invented = normalizeEvidence({ ...raw, provenance: evidence[0].provenance }, run, "agent", "E-002");
    expect(invented.provenance).toBeUndefined();
    expect(invented.verificationStatus).toBe("unverified");
    expect(invented.retrievedAt).toBe("");
  });
  test("rejects mismatched excerpts, failed retrieval and fabricated user verification", async () => {
    const { root, run, sources } = await fixture();
    const mismatch = mergeEvidence([], [{ ...raw, excerpt: "A fabricated quote" }], run, "agent", { sources });
    expect(mismatch[0].provenance).toBeUndefined();
    expect(auditResearchEvidence(run, mismatch, "99 dollars [E-001].").status).toBe("fail");
    expect((await collectResearchSources(root, run, [raw], async () => { throw new Error("blocked"); })).size).toBe(0);
    const fake = normalizeEvidence({ ...raw, sourceTier: "user-observation" }, run, "agent", "E-001");
    expect(fake.verificationStatus).toBe("unverified");
    expect(fake.sourceTier).toBe("unknown");
  });
  test("only a recorded user submission can establish user verification", async () => {
    const { root, run } = await fixture();
    const observation = await recordUserObservation(root, run, "I measured 12 metres.", "2026-09-05");
    const evidence = mergeEvidence([], [{ claim: "Length is 12 metres.", kind: "fact", sourceTier: "user-observation", excerpt: observation.record.text }], run, "user-observation", { observation });
    expect(evidence[0].verificationStatus).toBe("user-verified");
    expect((await auditPersistedResearch(root, run, evidence, "Length is 12 metres [E-001].")).status).toBe("pass");
  });
  test("rejects missing, altered and symlinked source artifacts", async () => {
    const { root, run, evidence } = await fixture();
    const file = path.join(root, evidence[0].provenance!.path);
    await fs.writeFile(file, "{}");
    expect((await auditPersistedResearch(root, run, evidence, "99 dollars [E-001].")).issues.map((issue) => issue.code)).toContain("INVALID_SOURCE_ARTIFACT");
    await fs.rm(file);
    expect((await auditPersistedResearch(root, run, evidence, "99 dollars [E-001].")).status).toBe("fail");
    await fs.symlink(path.join(root, "absent"), file);
    expect((await auditPersistedResearch(root, run, evidence, "99 dollars [E-001].")).status).toBe("fail");
  });
  test("does not count a bibliography or an unrelated cited paragraph as claim support", async () => {
    const { run, evidence } = await fixture();
    const report = "Revenue is $9000000.\n\n" + formatEvidenceIndex(evidence);
    expect(auditResearchEvidence(run, evidence, report).status).toBe("fail");
    expect(auditResearchEvidence(run, evidence, report).citedEvidenceCount).toBe(0);
    expect(auditResearchEvidence(run, evidence, "Rate is 99 [E-001].\n\nRevenue is $9000000.").issues.map((issue) => issue.code)).toContain("UNCITED_NUMERIC_CLAIM");
    expect(auditResearchEvidence(run, evidence, "As of 2026-09-05.\n\nRate is 99 [E-001].").status).toBe("pass");
  });
  test("unresolved sources cannot pass and refresh preserves failed independent audits", async () => {
    const { run, evidence } = await fixture();
    for (const refreshStatus of ["failed", "changed"] as const) {
      expect(auditResearchEvidence(run, [{ ...evidence[0], refreshStatus }], "99 dollars [E-001].").status).toBe("fail");
    }
    const audit = auditResearchEvidence(run, evidence, "99 dollars [E-001].");
    run.independentAuditStatus = "fail";
    preserveResearchAuditAfterRefresh(run, audit);
    expect(audit.status).toBe("fail");
  });
  test("maps temporary citations and conflicts even across duplicate sources", async () => {
    const { run, sources, evidence } = await fixture();
    const merged = mergeResearchTrack(evidence, [raw, { ...raw, claim: "A contrary interpretation", conflictsWith: ["T1"] }], run, "skeptic", "T1 conflicts with T2", "Check T2", sources);
    expect(merged.findings).toBe("E-001 conflicts with E-002");
    expect(merged.openQuestions).toBe("Check E-002");
    expect(merged.evidence[1].conflictsWith).toEqual(["E-001"]);
  });
  test("re-baselining requires a matching host source and explicit manual review", async () => {
    const { root, run, sources, evidence } = await fixture();
    evidence[0].verificationStatus = "needs-review";
    expect(mergeEvidence(evidence, [raw], run, "agent", { sources })[0].verificationStatus).toBe("needs-review");
    const next = await recordResearchPage(root, run, { ...page("Updated rate. The rate is 99 dollars."), title: "Updated title", publisher: "Updated publisher" });
    sources.set(raw.sourceUrl!, next);
    const reviewed = mergeEvidence(evidence, [raw], run, "manual-source", { sources });
    expect(reviewed[0].verificationStatus).toBe("web-retrieved");
    expect((await auditPersistedResearch(root, run, reviewed, "99 dollars [E-001].")).status).toBe("pass");
  });
  test("rejects malformed records and ambiguous auditor verdicts", async () => {
    const { root, run } = await fixture();
    await writeResearchFile(root, run.paths.evidence, "not-json");
    await expect(readEvidence(root, run)).rejects.toThrow();
    expect(parseResearchAgentOutput("=== FINDINGS ===\ntext\n=== EVIDENCE JSON ===\n[null]\n=== OPEN QUESTIONS ===\nnone").parseWarning).toBeDefined();
    expect(parseIndependentAuditStatus('<research-audit status="pass"/>\n<research-audit status="fail"/>')).toBeUndefined();
    expect(parseIndependentAuditStatus('<research-audit status="pass"/> extra')).toBeUndefined();
  });
  test("retains skepticism at fast depth and refuses silently truncated audits", async () => {
    const { run, evidence } = await fixture();
    for (const mode of ["market", "general", "technical"] as const) expect(createResearchTracks(mode, "fast", 3).some((track) => track.id.startsWith("skeptic"))).toBe(true);
    expect(() => buildResearchAuditTask(run, "x".repeat(70_001), evidence)).toThrow(/review budget/);
    const quantitative = createResearchTracks("general", "decision-grade", 5).find((track) => track.id === "quantitative")!;
    expect(buildResearchAnalysisTask(run, quantitative, "COLLECTED-FIRST", evidence)).toContain("COLLECTED-FIRST");
  });
});
