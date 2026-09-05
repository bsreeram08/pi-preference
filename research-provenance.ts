import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { auditResearchEvidence, canonicalizeResearchUrl } from "./research-state.ts";
import type { ResearchFetchedPage } from "./research-tools.ts";
import type { ResearchEvidence, ResearchRun } from "./research-types.ts";

export interface ResearchSource {
  provenance: NonNullable<ResearchEvidence["provenance"]>;
  record: {
    version: 1; runId: string; kind: "retrieval" | "user-observation";
    text: string; recordedAt: string; observedAt?: string;
    page?: ResearchFetchedPage;
  };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const sourceText = (value: string) => value.replace(/\s+/g, " ").trim();

async function sourceDirectory(root: string, run: ResearchRun, create = false): Promise<string> {
  const canonical = await fs.realpath(root);
  const relative = `${run.paths.runDir}/sources`;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..")) throw new Error("Invalid research source directory.");
  let current = canonical;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Research source directory must be ordinary.");
  }
  return current;
}

async function saveSource(root: string, run: ResearchRun, record: ResearchSource["record"]): Promise<ResearchSource> {
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Research source artifact exceeds 2 MiB.");
  const name = `${randomUUID()}.json`;
  await fs.writeFile(path.join(await sourceDirectory(root, run, true), name), bytes, { flag: "wx", mode: 0o600 });
  return { provenance: { kind: record.kind, path: `${run.paths.runDir}/sources/${name}`, digest: hash(bytes) }, record };
}

export function recordResearchPage(root: string, run: ResearchRun, page: ResearchFetchedPage): Promise<ResearchSource> {
  if (!canonicalizeResearchUrl(page.requestedUrl) || !canonicalizeResearchUrl(page.finalUrl)
    || !page.text?.trim() || !Number.isFinite(Date.parse(page.retrievedAt))
    || !/^[a-f0-9]{64}$/.test(page.contentHash)) throw new Error("Invalid retrieved research page.");
  return saveSource(root, run, { version: 1, runId: run.id, kind: "retrieval", text: page.text, recordedAt: page.retrievedAt, page });
}

/** Only call from the UI observation submission, never with model output. */
export function recordUserObservation(root: string, run: ResearchRun, text: string, observedAt: string): Promise<ResearchSource> {
  if (!text.trim() || !Number.isFinite(Date.parse(observedAt))) throw new Error("Observation text and a valid date are required.");
  return saveSource(root, run, { version: 1, runId: run.id, kind: "user-observation", text, observedAt, recordedAt: new Date().toISOString() });
}

/** The parent independently retrieves each cited URL; child-authored hashes are ignored. */
export async function collectResearchSources(
  root: string, run: ResearchRun, entries: Array<Partial<ResearchEvidence>>,
  retrieve: (url: string) => Promise<ResearchFetchedPage>,
  cache = new Map<string, ResearchSource>(), signal?: AbortSignal,
): Promise<Map<string, ResearchSource>> {
  const urls = [...new Set(entries.map((entry) => canonicalizeResearchUrl(entry.sourceUrl)).filter((url): url is string => Boolean(url)))];
  if (urls.length > 100) throw new Error("A track exceeds the 100-source limit.");
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (cursor < urls.length) {
      signal?.throwIfAborted();
      const url = urls[cursor++];
      if (cache.has(url)) continue;
      try { cache.set(url, await recordResearchPage(root, run, await retrieve(url))); }
      catch { signal?.throwIfAborted(); /* Missing retrieval remains unverified in the ledger. */ }
    }
  }));
  return cache;
}

export async function auditPersistedResearch(root: string, run: ResearchRun, evidence: ResearchEvidence[], report: string) {
  const audit = auditResearchEvidence(run, evidence, report);
  for (const entry of evidence) {
    if (!entry.provenance) continue; // The deterministic audit flags missing provenance.
    try {
      const proof = entry.provenance;
      const name = path.posix.basename(proof.path);
      if (!/^[a-f0-9-]{36}\.json$/.test(name) || proof.path !== `${run.paths.runDir}/sources/${name}`) throw new Error("Invalid source path");
      const file = path.join(await sourceDirectory(root, run), name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid source file");
      const bytes = await fs.readFile(file, "utf8");
      if (hash(bytes) !== proof.digest) throw new Error("Changed source artifact");
      const record = JSON.parse(bytes) as ResearchSource["record"];
      if (record.version !== 1 || record.runId !== run.id || record.kind !== proof.kind || record.recordedAt !== entry.retrievedAt
        || !entry.excerpt?.trim() || !sourceText(record.text).includes(sourceText(entry.excerpt))) throw new Error("Source does not bind excerpt");
      if (proof.kind === "retrieval" && (!record.page
        || canonicalizeResearchUrl(record.page.requestedUrl) !== canonicalizeResearchUrl(entry.sourceUrl)
        || record.page.contentHash !== entry.contentHash || record.page.retrievedAt !== entry.retrievedAt
        || canonicalizeResearchUrl(record.page.canonicalUrl ?? record.page.finalUrl) !== entry.canonicalUrl
        || record.page.title !== entry.sourceTitle || record.page.publisher !== entry.publisher || record.page.publishedAt !== entry.publishedAt)) throw new Error("Retrieval metadata mismatch");
      if (proof.kind === "user-observation" && record.observedAt !== entry.observedAt) throw new Error("Observation date mismatch");
    } catch {
      audit.issues.push({ severity: "critical", code: "INVALID_SOURCE_ARTIFACT", evidenceId: entry.id, message: "Source artifact is missing, altered, or does not support the recorded excerpt/metadata." });
    }
  }
  audit.status = audit.issues.some((issue) => issue.severity === "critical") ? "fail" : audit.issues.some((issue) => issue.severity === "warning") ? "warning" : "pass";
  return audit;
}
