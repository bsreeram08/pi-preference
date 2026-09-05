export type ResearchMode = "market" | "technical" | "general";
export type ResearchDepth = "fast" | "decision-grade";
export type ResearchStatus =
  | "planning"
  | "running"
  | "synthesizing"
  | "auditing"
  | "complete"
  | "complete-with-gaps"
  | "blocked";

export type EvidenceKind = "fact" | "reported-claim" | "inference" | "recommendation";
export type SourceTier =
  | "primary"
  | "official"
  | "direct-platform"
  | "secondary"
  | "user-observation"
  | "unknown";
export type EvidenceConfidence = "high" | "medium" | "low";
export type VerificationStatus =
  | "web-retrieved"
  | "user-verified"
  | "unverified"
  | "needs-review";

export interface ResearchTrack {
  id: string;
  title: string;
  scope: string;
  preferredSources: string;
  status: "queued" | "running" | "complete" | "failed";
  agentId?: string;
  outputPath?: string;
  completedAt?: string;
  error?: string;
}

export interface ResearchRunPaths {
  runDir: string;
  plan: string;
  evidence: string;
  report: string;
  audit: string;
  manifest: string;
}

export interface ResearchRun {
  version: 1;
  id: string;
  projectRoot: string;
  question: string;
  decision: string;
  mode: ResearchMode;
  depth: ResearchDepth;
  geography?: string;
  asOf: string;
  status: ResearchStatus;
  createdAt: string;
  updatedAt: string;
  tracks: ResearchTrack[];
  paths: ResearchRunPaths;
  sourceTargetPerTrack: number;
  evidenceCount: number;
  auditStatus?: "pass" | "warning" | "fail";
  auditIssueCount?: number;
  independentAuditStatus?: "pass" | "warning" | "fail";
  providerSummary?: string[];
}

export interface ResearchEvidence {
  id: string;
  runId: string;
  trackId: string;
  claim: string;
  kind: EvidenceKind;
  sourceTier: SourceTier;
  confidence: EvidenceConfidence;
  verificationStatus: VerificationStatus;
  sourceUrl?: string;
  canonicalUrl?: string;
  sourceTitle?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  observedAt?: string;
  excerpt?: string;
  geography?: string;
  volatile: boolean;
  contentHash?: string;
  conflictsWith?: string[];
  notes?: string;
  lastCheckedAt?: string;
  refreshStatus?: "unchanged" | "changed" | "baseline-established" | "failed";
  refreshError?: string;
  provenance?: { kind: "retrieval" | "user-observation"; path: string; digest: string };
}

export interface ParsedResearchAgentOutput {
  findings: string;
  evidence: Array<Partial<ResearchEvidence> & { claim?: string }>;
  openQuestions: string;
  parseWarning?: string;
}

export interface ResearchAuditIssue {
  severity: "critical" | "warning" | "suggestion";
  code: string;
  message: string;
  evidenceId?: string;
}

export interface ResearchAuditResult {
  status: "pass" | "warning" | "fail";
  issues: ResearchAuditIssue[];
  evidenceCount: number;
  citedEvidenceCount: number;
  sourceDomainCount: number;
}
