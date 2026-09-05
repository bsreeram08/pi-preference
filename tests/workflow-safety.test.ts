import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertMandatoryAgentBatch,
  assertMandatoryAgentResult,
  MandatoryAgentResultError,
  WorkflowCancellationError,
} from "../agent-result-guard.ts";
import { runSingleAgent } from "../subagents.ts";
import {
  acquireExclusiveLease,
  acquireExclusiveLeaseAtPath,
  acquireUpdateExclusiveLease,
  ExclusiveLeaseError,
  withExclusiveLease,
  type ExclusiveLeaseDependencies,
  type ProcessInspection,
} from "../exclusive-lease.ts";
import {
  assertWorkflowAuthorityUnchanged,
  captureWorkflowAuthority,
  ensureWorkflowState,
  getWorkflowPaths,
  loadCurrentWorkflowPlan,
  saveWorkflowPlan,
  writeWorkflowRunArtifact,
  WorkflowStateCorruptionError,
  WorkflowStateSnapshotMismatchError,
  type WorkflowPlanState,
} from "../workflow-state.ts";
import { bindWorkflowTaskPacket, canonicalWorkflowTaskPacketMarker, evaluateWorkflowVerification, type WorkflowTaskPacketDeclaration } from "../workflow-task-packet.ts";
import { observedChecks } from "./fixtures/check-evidence.ts";
import type { AgentResult, AgentSpec } from "../types.ts";

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return { agentId: "planner", title: "Planner", output: "valid output", exitCode: 0, ...overrides };
}

function plan(id = "2026-08-25T00-00-00-000Z-safe-plan"): WorkflowPlanState {
  return {
    version: 1,
    id,
    task: "Implement workflow safety",
    status: "approved",
    plan: "# Plan\n\nImplement it.",
    interviewNotes: "",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    reviewRounds: 1,
    planPath: "",
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const PACKET_DECLARATION: WorkflowTaskPacketDeclaration = {
  schemaVersion: 1,
  scope: ["Persist a bound workflow task packet."],
  nonGoals: ["Do not execute packet content."],
  acceptanceCriteria: [{ id: "state-roundtrip", description: "Valid packet state round-trips.", requiredEvidenceKinds: ["automated-test"] }],
};

function packetPlan(): string {
  return `# Plan\n\nImplement it.\n\n${canonicalWorkflowTaskPacketMarker(PACKET_DECLARATION)}`;
}

function passingVerification(planText: string) {
  const packet = bindWorkflowTaskPacket(planText);
  return evaluateWorkflowVerification(`<workflow-verification>${JSON.stringify({
    schemaVersion: 1,
    packetId: packet.packetId,
    planDigest: packet.planDigest,
    criteria: [{ criterionId: "state-roundtrip", status: "passed", evidence: [{ kind: "automated-test", summary: "State tests passed." }] }],
  })}</workflow-verification>`, packet, observedChecks(packet.acceptanceCriteria));
}

function leaseDependencies(
  pid: number,
  token: string,
  inspect: (pid: number) => ProcessInspection,
  agentDir?: string,
): ExclusiveLeaseDependencies {
  return {
    ...(agentDir ? { agentDir } : {}),
    pid,
    token: () => token,
    hostname: "test-host",
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    inspectProcess: async (target) => inspect(target),
  };
}

describe("mandatory AgentResult guard", () => {
  test("rejects nonzero, cancelled exit-zero, and blank mandatory results", () => {
    expect(() => assertMandatoryAgentResult(result({ exitCode: 2 }), "discovery")).toThrow(MandatoryAgentResultError);
    expect(() => assertMandatoryAgentResult(result({ cancelled: true }), "clearance")).toThrow(WorkflowCancellationError);
    expect(() => assertMandatoryAgentResult(result({ output: " \n\t" }), "requirements")).toThrow(MandatoryAgentResultError);
  });

  test("validates every batch member", () => {
    expect(() => assertMandatoryAgentBatch([result(), result({ agentId: "technical", output: "" })], "review")).toThrow("member 2");
    expect(assertMandatoryAgentBatch([result(), result({ agentId: "technical" })], "review")).toHaveLength(2);
  });
});

describe("atomic workflow state", () => {
  test("returns undefined only when current.json is absent", async () => {
    const root = await temporaryRoot("workflow-state-absent-");
    try {
      expect(await loadCurrentWorkflowPlan(getWorkflowPaths(root))).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("preserves previous current.json when plan or current commit faults and cleans temp files", async () => {
    const root = await temporaryRoot("workflow-state-fault-");
    const paths = getWorkflowPaths(root);
    try {
      const previous = plan("previous-plan");
      await saveWorkflowPlan(paths, previous);
      const next = plan("next-plan");
      next.task = "Next";
      await expect(saveWorkflowPlan(paths, next, { beforePlanCommit: () => { throw new Error("plan fault"); } })).rejects.toThrow("plan fault");
      expect((await loadCurrentWorkflowPlan(paths))?.id).toBe("previous-plan");
      await expect(saveWorkflowPlan(paths, next, { beforeCurrentCommit: () => { throw new Error("current fault"); } })).rejects.toThrow("current fault");
      expect((await loadCurrentWorkflowPlan(paths))?.id).toBe("previous-plan");
      expect((await fs.readdir(paths.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect((await fs.readdir(paths.plans)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("keeps current.json authoritative when a same-plan projection commits before current write fails", async () => {
    const root = await temporaryRoot("workflow-state-same-plan-fault-");
    const paths = getWorkflowPaths(root);
    try {
      const previous = plan("same-plan");
      previous.task = "Authoritative task";
      await saveWorkflowPlan(paths, previous);
      const next = { ...previous, plan: "# Plan\n\nProjection-only update.", updatedAt: "2026-08-25T00:01:00.000Z" };

      await expect(saveWorkflowPlan(paths, next, { beforeCurrentCommit: () => { throw new Error("current fault"); } })).rejects.toThrow("current fault");

      expect((await loadCurrentWorkflowPlan(paths))?.plan).toBe("# Plan\n\nImplement it.");
      expect(await fs.readFile(previous.planPath, "utf8")).toContain("Projection-only update");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent saves per workflow root", async () => {
    const root = await temporaryRoot("workflow-state-concurrent-");
    const paths = getWorkflowPaths(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = saveWorkflowPlan(paths, plan("first-plan"), { beforeCurrentCommit: () => gate });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = saveWorkflowPlan(paths, plan("second-plan"));
      release();
      await Promise.all([first, second]);
      expect((await loadCurrentWorkflowPlan(paths))?.id).toBe("second-plan");
    } finally {
      release();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("throws typed corruption for malformed, unsafe, unknown, and incomplete execution state", async () => {
    const root = await temporaryRoot("workflow-state-corrupt-");
    const paths = getWorkflowPaths(root);
    await fs.mkdir(paths.root, { recursive: true });
    try {
      await fs.writeFile(paths.current, "{bad json", "utf8");
      await expect(loadCurrentWorkflowPlan(paths)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);

      const valid = plan("valid-plan");
      await saveWorkflowPlan(paths, valid);
      const stored = JSON.parse(await fs.readFile(paths.current, "utf8"));
      for (const broken of [
        { ...stored, version: 2 },
        { ...stored, id: "../escape" },
        { ...stored, planPath: path.join(root, "outside.md") },
        { ...stored, status: "unknown" },
        { ...stored, reviewRounds: Number.POSITIVE_INFINITY },
        { ...stored, updatedAt: "not-an-iso-time" },
        { ...stored, status: "executing", execution: { attempts: 1, verificationPassed: false } },
        { ...stored, status: "verified", execution: { startedAt: stored.createdAt, attempts: 1, verificationPassed: false } },
        { ...stored, status: "executing", execution: { startedAt: stored.createdAt, completedAt: stored.updatedAt, attempts: 1, verificationPassed: false } },
        { ...stored, status: "blocked", execution: { startedAt: stored.createdAt, attempts: 1, verificationPassed: false } },
        { ...stored, status: "cancelled", execution: { startedAt: stored.createdAt, attempts: 1, verificationPassed: false } },
        { ...stored, status: "interrupted", execution: { startedAt: stored.createdAt, attempts: 1, verificationPassed: false } },
        { ...stored, status: "verified", execution: { startedAt: "2026-08-26T00:00:00.000Z", completedAt: stored.createdAt, attempts: 1, verificationPassed: true } },
      ]) {
        await fs.writeFile(paths.current, `${JSON.stringify(broken)}\n`, "utf8");
        await expect(loadCurrentWorkflowPlan(paths)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("keeps packetless v1 compatibility and round-trips a valid bound packet", async () => {
    const root = await temporaryRoot("workflow-state-packet-roundtrip-");
    const paths = getWorkflowPaths(root);
    try {
      const legacy = plan("legacy-plan");
      await saveWorkflowPlan(paths, legacy);
      expect((await loadCurrentWorkflowPlan(paths))?.verificationMode).toBeUndefined();
      expect((await loadCurrentWorkflowPlan(paths))?.packet).toBeUndefined();

      const packetState = plan("packet-plan");
      packetState.plan = packetPlan();
      packetState.verificationMode = "packet";
      packetState.packet = bindWorkflowTaskPacket(packetState.plan);
      await saveWorkflowPlan(paths, packetState);
      expect((await loadCurrentWorkflowPlan(paths))?.packet).toEqual(packetState.packet);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("packet verification mode prevents packet field-deletion downgrade", async () => {
    const root = await temporaryRoot("workflow-state-packet-downgrade-");
    const paths = getWorkflowPaths(root);
    try {
      const state = plan("packet-downgrade");
      state.plan = packetPlan();
      state.verificationMode = "packet";
      state.packet = bindWorkflowTaskPacket(state.plan);
      await saveWorkflowPlan(paths, state);
      const stored = JSON.parse(await fs.readFile(paths.current, "utf8"));

      for (const broken of [
        { ...stored, packet: undefined },
        { ...stored, verificationMode: undefined },
        { ...stored, verificationMode: undefined, packet: undefined },
      ]) {
        await fs.writeFile(paths.current, `${JSON.stringify(broken)}\n`, "utf8");
        await expect(loadCurrentWorkflowPlan(paths)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects changed packet plan, declaration, digest, id, and unknown nested fields", async () => {
    const root = await temporaryRoot("workflow-state-packet-corrupt-");
    const paths = getWorkflowPaths(root);
    try {
      const state = plan("packet-corrupt");
      state.plan = packetPlan();
      state.verificationMode = "packet";
      state.packet = bindWorkflowTaskPacket(state.plan);
      await saveWorkflowPlan(paths, state);
      const stored = JSON.parse(await fs.readFile(paths.current, "utf8"));
      for (const broken of [
        { ...stored, plan: `${stored.plan}\nchanged` },
        { ...stored, packet: { ...stored.packet, scope: ["changed"] } },
        { ...stored, packet: { ...stored.packet, planDigest: `sha256:${"0".repeat(64)}` } },
        { ...stored, packet: { ...stored.packet, packetId: `wtp-${"0".repeat(32)}` } },
        { ...stored, packet: { ...stored.packet, acceptanceCriteria: [{ ...stored.packet.acceptanceCriteria[0], unknown: true }] } },
      ]) {
        await fs.writeFile(paths.current, `${JSON.stringify(broken)}\n`, "utf8");
        await expect(loadCurrentWorkflowPlan(paths)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects packet verification without a packet and incomplete packet-verified state", async () => {
    const root = await temporaryRoot("workflow-state-packet-verification-");
    const paths = getWorkflowPaths(root);
    try {
      const packetState = plan("packet-verified");
      packetState.plan = packetPlan();
      packetState.verificationMode = "packet";
      packetState.packet = bindWorkflowTaskPacket(packetState.plan);
      const verification = passingVerification(packetState.plan);
      packetState.status = "verified";
      packetState.execution = {
        startedAt: packetState.createdAt,
        completedAt: packetState.updatedAt,
        attempts: 1,
        verificationPassed: true,
        packetVerification: verification,
      };
      await saveWorkflowPlan(paths, packetState);

      const stored = JSON.parse(await fs.readFile(paths.current, "utf8"));
      for (const broken of [
        { ...stored, packet: undefined },
        { ...stored, execution: { ...stored.execution, packetVerification: undefined } },
        { ...stored, execution: { ...stored.execution, packetVerification: { ...stored.execution.packetVerification, result: "failed" } } },
        { ...stored, execution: { ...stored.execution, packetVerification: { ...stored.execution.packetVerification, criteria: [{ ...stored.execution.packetVerification.criteria[0], unknown: true }] } } },
      ]) {
        await fs.writeFile(paths.current, `${JSON.stringify(broken)}\n`, "utf8");
        await expect(loadCurrentWorkflowPlan(paths)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);
      }

      const legacy = plan("legacy-with-verification");
      legacy.status = "blocked";
      legacy.execution = { startedAt: legacy.createdAt, completedAt: legacy.updatedAt, attempts: 1, verificationPassed: false, packetVerification: verification };
      await expect(saveWorkflowPlan(paths, legacy)).rejects.toBeInstanceOf(WorkflowStateCorruptionError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an authoritative snapshot mismatch without changing persisted state", async () => {
    const root = await temporaryRoot("workflow-state-snapshot-");
    const paths = getWorkflowPaths(root);
    try {
      await saveWorkflowPlan(paths, plan("confirmed-plan"));
      const snapshot = await captureWorkflowAuthority(paths);
      const replacement = plan("replacement-plan");
      replacement.task = "New authoritative task";
      await saveWorkflowPlan(paths, replacement);
      const currentBeforeGuard = await fs.readFile(paths.current, "utf8");
      const replacementPlanBeforeGuard = await fs.readFile(replacement.planPath, "utf8");

      await expect(assertWorkflowAuthorityUnchanged(paths, snapshot)).rejects.toBeInstanceOf(WorkflowStateSnapshotMismatchError);
      expect(await fs.readFile(paths.current, "utf8")).toBe(currentBeforeGuard);
      expect(await fs.readFile(replacement.planPath, "utf8")).toBe(replacementPlanBeforeGuard);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlink and special authoritative files", async () => {
    const root = await temporaryRoot("workflow-state-kind-");
    const paths = getWorkflowPaths(root);
    await fs.mkdir(paths.root, { recursive: true });
    const target = path.join(root, "target.json");
    try {
      await fs.writeFile(target, "{}", "utf8");
      await fs.symlink(target, paths.current);
      await expect(loadCurrentWorkflowPlan(paths)).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
      await fs.unlink(paths.current);
      await fs.mkdir(paths.current);
      await expect(loadCurrentWorkflowPlan(paths)).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked workflow directory on load and save", async () => {
    const root = await temporaryRoot("workflow-state-parent-link-");
    const external = await temporaryRoot("workflow-state-external-");
    const paths = getWorkflowPaths(root);
    try {
      await fs.symlink(external, paths.root, "dir");
      await expect(loadCurrentWorkflowPlan(paths)).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
      await expect(saveWorkflowPlan(paths, plan("linked-parent"))).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
      expect(await fs.readdir(external)).toEqual([]);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(external, { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects symlinked and special artifact destinations without writing outside state", async () => {
    const root = await temporaryRoot("workflow-artifact-link-");
    const external = path.join(await temporaryRoot("workflow-artifact-external-"), "outside.md");
    const paths = getWorkflowPaths(root);
    try {
      await ensureWorkflowState(paths);
      const runDir = path.join(paths.runs, "safe-plan");
      await fs.mkdir(runDir);
      await fs.writeFile(external, "outside\n");
      const artifact = path.join(runDir, "result.md");
      await fs.symlink(external, artifact);
      await expect(writeWorkflowRunArtifact(paths, "safe-plan", "result.md", "secret")).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
      expect(await fs.readFile(external, "utf8")).toBe("outside\n");
      await fs.unlink(artifact);
      await fs.mkdir(artifact);
      await expect(writeWorkflowRunArtifact(paths, "safe-plan", "result.md", "secret")).rejects.toMatchObject({ code: "authoritative_file_unsafe" });
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(path.dirname(external), { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects a symlinked run directory without writing outside state", async () => {
    const root = await temporaryRoot("workflow-run-link-");
    const external = await temporaryRoot("workflow-run-external-");
    const paths = getWorkflowPaths(root);
    try {
      await ensureWorkflowState(paths);
      await fs.symlink(external, path.join(paths.runs, "linked-plan"), "dir");
      await expect(writeWorkflowRunArtifact(paths, "linked-plan", "result.md", "secret")).rejects.toMatchObject({
        code: "authoritative_file_unsafe",
      });
      expect(await fs.readdir(external)).toEqual([]);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(external, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("project-scoped writer lease", () => {
  test("treats plan as a project writer that contends with updates", async () => {
    const root = await temporaryRoot("writer-plan-operation-");
    const agentDir = path.join(root, "agent");
    const dependencies = leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), agentDir);
    try {
      const lease = await acquireExclusiveLease(root, "plan", dependencies);
      expect(lease.owner.operation).toBe("plan");
      await expect(acquireUpdateExclusiveLease(root, { ...dependencies, pid: 202, token: () => UUID_B })).rejects.toMatchObject({ code: "active_writers" });
      await lease.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("blocks live contention and never takes over stale, reused, malformed, or ambiguous owners", async () => {
    const scenarios: Array<{ name: string; setup?: (lock: string) => Promise<void>; inspect: (pid: number) => ProcessInspection; expected: string }> = [
      { name: "live", inspect: (pid) => ({ kind: "live", startIdentity: pid === 101 ? "owner-start" : "new-start" }), expected: "writer_live" },
      { name: "stale", inspect: (pid) => pid === 101 ? { kind: "missing" } : { kind: "live", startIdentity: "new-start" }, expected: "writer_stale" },
      { name: "pid-reused", inspect: (pid) => ({ kind: "live", startIdentity: pid === 101 ? "replacement-start" : "new-start" }), expected: "writer_stale" },
      { name: "ambiguous", inspect: (pid) => pid === 101 ? { kind: "ambiguous" } : { kind: "live", startIdentity: "new-start" }, expected: "writer_ambiguous" },
      { name: "malformed", setup: async (lock) => { await fs.writeFile(lock, "not json", "utf8"); }, inspect: () => ({ kind: "live", startIdentity: "new-start" }), expected: "writer_malformed" },
    ];

    for (const scenario of scenarios) {
      const root = await temporaryRoot(`writer-${scenario.name}-`);
      const agentDir = path.join(root, "agent");
      try {
        const first = await acquireExclusiveLease(root, "start-work", leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), agentDir));
        if (scenario.setup) await scenario.setup(first.path);
        await expect(acquireExclusiveLease(root, "autopilot", leaseDependencies(202, UUID_B, scenario.inspect, agentDir))).rejects.toMatchObject({
          code: scenario.expected,
        });
        expect(await fs.lstat(first.path)).toBeDefined();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  test("treats a different-host owner as ambiguous without inspecting its PID", async () => {
    const root = await temporaryRoot("writer-cross-host-");
    const agentDir = path.join(root, "agent");
    try {
      const first = await acquireExclusiveLease(root, "start-work", {
        ...leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), agentDir),
        hostname: "owner-host",
      });
      const inspected: number[] = [];
      await expect(acquireExclusiveLease(root, "autopilot", {
        ...leaseDependencies(202, UUID_B, (pid) => {
          inspected.push(pid);
          if (pid === 101) throw new Error("remote owner PID must not be inspected locally");
          return { kind: "live", startIdentity: "contender-start" };
        }, agentDir),
        hostname: "contender-host",
      })).rejects.toMatchObject({ code: "writer_ambiguous" });
      expect(inspected).toEqual([202]);
      await first.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("releases in finally but never deletes a replacement project token", async () => {
    const root = await temporaryRoot("writer-release-");
    const dependencies = leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), path.join(root, "agent"));
    try {
      await expect(withExclusiveLease(root, "start-work", async () => { throw new Error("work failed"); }, dependencies)).rejects.toThrow("work failed");
      await expect(fs.access(path.join(root, ".pi", "pi-workbench", "writer.lock"))).rejects.toThrow();

      const lease = await acquireExclusiveLease(root, "autopilot", dependencies);
      const replacement = { ...lease.owner, token: UUID_B };
      await fs.writeFile(lease.path, `${JSON.stringify(replacement)}\n`, "utf8");
      await lease.release();
      expect(JSON.parse(await fs.readFile(lease.path, "utf8")).token).toBe(UUID_B);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("allows distinct projects to hold active writer markers concurrently", async () => {
    const firstRoot = await temporaryRoot("writer-root-a-");
    const secondRoot = await temporaryRoot("writer-root-b-");
    const agentDir = path.join(firstRoot, "agent");
    const dependencies = leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), agentDir);
    try {
      const first = await acquireExclusiveLease(firstRoot, "start-work", dependencies);
      const second = await acquireExclusiveLease(secondRoot, "start-work", { ...dependencies, token: () => UUID_B });
      expect(first.path).not.toBe(second.path);
      expect(await fs.readdir(path.join(agentDir, "update", "pi-workbench", "writers"))).toHaveLength(2);
      await Promise.all([first.release(), second.release()]);
    } finally {
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("active workflows block updates and active updates block workflow launch", async () => {
    const root = await temporaryRoot("writer-update-coordination-");
    const agentDir = path.join(root, "agent");
    const inspect = (pid: number): ProcessInspection => ({ kind: "live", startIdentity: pid === 101 ? "owner-start" : "contender-start" });
    const owner = leaseDependencies(101, UUID_A, inspect, agentDir);
    const contender = leaseDependencies(202, UUID_B, inspect, agentDir);
    try {
      const writer = await acquireExclusiveLease(root, "start-work", owner);
      await expect(acquireUpdateExclusiveLease(root, contender)).rejects.toMatchObject({ code: "active_writers" });
      expect(await fs.lstat(path.join(agentDir, "update", "pi-workbench", "update.lock")).catch(() => undefined)).toBeUndefined();
      await writer.release();

      const updater = await acquireUpdateExclusiveLease(root, owner);
      let launched = false;
      await expect(withExclusiveLease(root, "autopilot", async () => { launched = true; }, contender)).rejects.toMatchObject({ code: "update_active" });
      expect(launched).toBe(false);
      await updater.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("holds the coordination gate across the update check and writer marker creation", async () => {
    const root = await temporaryRoot("writer-gate-ordering-");
    const agentDir = path.join(root, "agent");
    let checked!: () => void;
    let continueAcquisition!: () => void;
    const reachedCheck = new Promise<void>((resolve) => { checked = resolve; });
    const acquisitionMayContinue = new Promise<void>((resolve) => { continueAcquisition = resolve; });
    const inspect = (pid: number): ProcessInspection => ({ kind: "live", startIdentity: pid === 101 ? "owner-start" : "contender-start" });
    const owner: ExclusiveLeaseDependencies = {
      ...leaseDependencies(101, UUID_A, inspect, agentDir),
      afterCoordinationCheck: async (role) => {
        if (role !== "writer") return;
        checked();
        await acquisitionMayContinue;
      },
    };
    try {
      const pendingWriter = acquireExclusiveLease(root, "start-work", owner);
      await reachedCheck;
      await expect(acquireUpdateExclusiveLease(root, leaseDependencies(202, UUID_B, inspect, agentDir))).rejects.toMatchObject({ code: "writer_live" });
      continueAcquisition();
      const writer = await pendingWriter;
      await writer.release();
    } finally {
      continueAcquisition?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed coordination artifacts and releases markers token-safely", async () => {
    const root = await temporaryRoot("writer-coordination-artifacts-");
    const agentDir = path.join(root, "agent");
    const dependencies = leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }), agentDir);
    try {
      const writer = await acquireExclusiveLease(root, "start-work", dependencies);
      const writersDirectory = path.join(agentDir, "update", "pi-workbench", "writers");
      const [markerName] = await fs.readdir(writersDirectory);
      const markerPath = path.join(writersDirectory, markerName!);
      const replacement = { ...JSON.parse(await fs.readFile(markerPath, "utf8")), token: UUID_B };
      await fs.writeFile(markerPath, `${JSON.stringify(replacement)}\n`);
      await writer.release();
      expect(JSON.parse(await fs.readFile(markerPath, "utf8")).token).toBe(UUID_B);
      await fs.unlink(markerPath);

      const updatePath = path.join(agentDir, "update", "pi-workbench", "update.lock");
      await fs.writeFile(updatePath, "malformed\n", { mode: 0o600 });
      await expect(acquireExclusiveLease(root, "autopilot", dependencies)).rejects.toMatchObject({ code: "update_active" });
      await fs.unlink(updatePath);

      const updater = await acquireUpdateExclusiveLease(root, dependencies);
      const updateReplacement = { ...updater.owner, token: UUID_B };
      await fs.writeFile(updater.path, `${JSON.stringify(updateReplacement)}\n`);
      await updater.release();
      expect(JSON.parse(await fs.readFile(updater.path, "utf8")).token).toBe(UUID_B);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("supports the fixed updater lock path without changing project writer paths", async () => {
    const root = await temporaryRoot("writer-update-");
    const canonicalRoot = await fs.realpath(root);
    const lockPath = path.join(canonicalRoot, "agent", "update", "pi-workbench", "update.lock");
    const dependencies = leaseDependencies(101, UUID_A, () => ({ kind: "live", startIdentity: "owner-start" }));
    try {
      const lease = await acquireExclusiveLeaseAtPath(canonicalRoot, lockPath, "workbench-update", dependencies);
      expect(lease.path).toBe(lockPath);
      expect(lease.owner.operation).toBe("workbench-update");
      await expect(acquireExclusiveLeaseAtPath(canonicalRoot, lockPath, "workbench-update", {
        ...dependencies,
        pid: 202,
        token: () => UUID_B,
        inspectProcess: async (pid) => ({ kind: "live", startIdentity: pid === 101 ? "owner-start" : "contender-start" }),
      })).rejects.toMatchObject({ code: "writer_live" });
      await lease.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reports categorical lease errors without process output", () => {
    const error = new ExclusiveLeaseError("writer_ambiguous", "ambiguous");
    expect(error.message).toBe("Project writer lease is unavailable (ambiguous).");
  });
});

describe("pre-spawn cancellation", () => {
  test("returns a cancelled result without launching an agent process", async () => {
    const root = await temporaryRoot("agent-pre-spawn-cancel-");
    const controller = new AbortController();
    controller.abort();
    const agent: AgentSpec = {
      id: "cancelled-agent",
      title: "Cancelled Agent",
      description: "Must never launch",
      triggers: [],
      readOnly: true,
    };
    try {
      const result = await runSingleAgent(root, agent, "System prompt", "SENTINEL_TASK", controller.signal);
      expect(result).toMatchObject({ exitCode: 1, cancelled: true });
      expect(result.output).toBe("");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
