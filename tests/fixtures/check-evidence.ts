import type { VerificationEvidence } from "../../verification.ts";
import type { WorkflowAcceptanceCriterion } from "../../workflow-task-packet.ts";

// Trusted-runtime fixture for orchestration/codec tests. Real execution is covered
// by verification.test.ts and the AgentRunManager process tests.
export function observedChecks(criteria: readonly WorkflowAcceptanceCriterion[] = [
  { id: "workflow-complete", description: "behavior", requiredEvidenceKinds: ["automated-test"] },
]): VerificationEvidence {
  const snapshot = "a".repeat(64);
  return { snapshot, receipts: criteria.flatMap((criterion, index) => criterion.requiredEvidenceKinds.map((kind) => ({
    version: 1 as const, id: `fixture-${index}-${kind}`, runId: "fixture-run",
    argv: ["bun", "test"], cwd: "/fixture", criterionIds: [criterion.id], kind,
    exitCode: 0, signal: null, interrupted: false, outputLimitExceeded: false,
    outputDigest: "b".repeat(64), snapshotBefore: snapshot, snapshotAfter: snapshot,
    startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:01.000Z",
  }))) };
}
