# `pi-extensible-workflows` comparison

> Reviewed: 2026-08-25  
> Upstream implementation: [`aa9901861e8971fc7b2380f2ae10f2f351a66e4a`](https://github.com/vekexasia/pi-extensible-workflows/tree/aa9901861e8971fc7b2380f2ae10f2f351a66e4a) (`5.8.0`)
> Scope: workflow composition, routing, lifecycle, observability, persistence, recovery, cancellation, worktrees, and safety

## Sources

- [README at the reviewed commit](https://github.com/vekexasia/pi-extensible-workflows/blob/aa9901861e8971fc7b2380f2ae10f2f351a66e4a/README.md)
- [Core runtime runner](https://github.com/vekexasia/pi-extensible-workflows/blob/aa9901861e8971fc7b2380f2ae10f2f351a66e4a/packages/core/src/pi-runtime-runner.ts)
- [Workflow result contract](https://github.com/vekexasia/pi-extensible-workflows/blob/aa9901861e8971fc7b2380f2ae10f2f351a66e4a/packages/core/src/runtime/workflow-result.ts)
- [Persistence implementation](https://github.com/vekexasia/pi-extensible-workflows/blob/aa9901861e8971fc7b2380f2ae10f2f351a66e4a/packages/core/src/persistence.ts)
- [Herdr extension controls](https://github.com/vekexasia/pi-extensible-workflows/blob/aa9901861e8971fc7b2380f2ae10f2f351a66e4a/packages/extensions/herdr/index.ts)
- [Repository tree at the reviewed commit](https://api.github.com/repos/vekexasia/pi-extensible-workflows/git/trees/aa9901861e8971fc7b2380f2ae10f2f351a66e4a?recursive=1)

The conclusions below come from an implementation-level review pinned to that commit plus independent review of the corresponding Pi Workbench changes. Documentation-only claims remain labeled as documented.

## Comparison

| Area | `pi-extensible-workflows` | Pi Workbench | Decision |
|---|---|---|---|
| Composition | Documents reusable `agent`, `parallel`, `pipeline`, `withWorktree`, `checkpoint`, and `defineWorkflowFunction` primitives, including model-authored JavaScript workflows. | Uses a trusted, purpose-built sequence in `workflow.ts`: discovery, requirements, reviewed plan, approval, single-writer execution, review/fix loops, and independent verification. | **Adapt typed internal primitives later; reject arbitrary generated code execution.** |
| Routing | Documents model aliases and role files that can carry model/tool/policy settings. The reviewed sources do not establish task-difficulty classification. | `routing.ts` classifies complexity, uncertainty, risk, breadth, and verification cost, then selects Luna, Terra, or Sol. Role is only a prior. | **Keep Workbench task-based routing.** |
| Writer safety | Provides `withWorktree()`, but the reviewed documentation does not establish a universal one-writer invariant. | Parallel normal delegation is read-only; all actual mutation entrypoints also acquire one fail-closed lease per canonical project/worktree root. Isolated council worktrees remain independent and have one leased integrator for the main tree. | **Keep Workbench’s stricter invariant.** |
| Checkpoints | Provides a reusable approval checkpoint primitive. | Has explicit plan approval and verification gates embedded in the workflow. | **Adapt a typed checkpoint representation only if it reduces duplication without weakening gates.** |
| State and resume | Describes deterministic, resumable workflows and durable inspect/stop/retry controls. The supplied sources do not expose enough implementation detail to verify replay safety. | Keeps one validated full-state `current.json`, atomically replaced last after its plan projection. Corruption is visible; cancellation and interruption are terminal persisted states. Workbench intentionally has no replay or resume path. | **Keep atomic state safety without adopting automatic replay/resume.** |
| Observability | Documents live workflow trees, costs, trajectory/Gantt views, and steer/stop controls. | Has dashboard state, route receipts, artifacts, Pi subagent controls, and a versioned categorical lifecycle stream that cannot carry prompt/task/output/detail/summary/error/tool-name content. | **Keep the metadata-only contract; avoid transcript/tool-input telemetry.** |
| Architecture | Uses a multi-package workspace with core, CLI, and extension packages. | Uses one extension repository split into focused TypeScript modules. | **Do not migrate package structure without a concrete scaling problem.** |

## Implementation-proven Pi Workbench gaps closed in this change

1. **Mandatory phases previously failed open.** Nonzero, cancelled, blank, malformed-clearance, failed-batch, and malformed blocker results could reach later gates. Mandatory `AgentResult` validation and strict clearance/blocker parsing now stop the run before downstream consumption.
2. **Workflow state writes were not atomic or corruption-visible.** Plan projection and authoritative state now use adjacent temporary files and rename, validate their complete shapes, distinguish missing state from corruption, reject unsafe directory/file types, and serialize in-process writes.
3. **Child cancellation did not cancel the enclosing run.** Confirmed planning, execution, and autopilot commands now own a cancellation signal; dashboard and overlay cancel-all controls abort that run before cancelling children, and every pre-spawn boundary checks the signal.
4. **cmux metadata could contain prompt/error-derived text.** The companion now accepts only a versioned categorical lifecycle contract. Sentinel tests prove prompts, task text, summaries, raw errors, labels, and tool names cannot reach cmux metadata.
5. **There was no safe automatic resume foundation.** This change intentionally adds terminal `cancelled`/`interrupted` persistence but no journal, fingerprint, replay, or resume path; automatic writer replay remains rejected until crash reconciliation can be proved.
6. **There was no cross-session writer ownership.** A fail-closed project/worktree-scoped lease now guards every mutation entrypoint, blocks ambiguous/stale/reused/malformed owners, and never waits or takes over.
7. **Lifecycle and result contracts lacked negative-path coverage.** Focused tests now cover malformed mandatory outputs, cancellation boundaries, metadata redaction, interrupted writes, corruption, authority races, link/path escapes, and lease contention.
8. **The large orchestration function still lacks a small runner seam.** A narrow run-lifecycle helper was added for cancellation ownership, but the fixed reviewed workflow remains purpose-built rather than converted into a general model-authored runner.

## Adopted in this change

1. **Metadata-only lifecycle contract**
   - `workflow.ts` emits `pi-workbench:workflow-lifecycle:v1`, constructed and decoded by `workflow-lifecycle.ts` from allowlisted phase, state, and categorical error code only.
   - `cmux-workbench.ts`, registered by the main directory extension, maps that contract plus explicit `pi-subagents` and background-task terminal events to fixed titles, descriptions, progress, logs, statuses, and sparse notifications. It does not derive metadata from prompts or forward free-form event fields.

2. **Separate observability adapter**
   - The repository-owned cmux bridge updates title, description, status, progress, and sparse logs.
   - It does not edit or duplicate cmux’s generated `cmux-session.ts` feed bridge.

3. **Lifecycle and safety compatibility tests**
   - Tests cover explicit cmux targeting, sentinel-secret non-forwarding, bounded notification deduplication, absent-cmux failure behavior, mandatory-result failure modes, run cancellation, atomic state faults/corruption/concurrency, confirmation-time authority mismatches, and writer lease contention/classification/release.

4. **Atomic state without replay**
   - `workflow-state.ts` validates the complete full-state shape, serializes in-process saves per workflow root, commits the plan projection first, and atomically replaces authoritative `current.json` last.
   - Confirmation-gated commands use ephemeral in-memory snapshots only to reject changed workflow/council authority before launch or persistence. There are no persisted snapshots, fingerprints, journals, replay semantics, or resume command.

5. **Project-scoped writer ownership**
   - Write-capable workflow delegation, approved execution, autopilot, and same/new-session council implementation share one lease per canonical resolved worktree root.
   - Live, stale, PID-reused, ambiguous, and malformed existing owners all block without waiting, deletion, or takeover.

## Recommended follow-up

### P1 — Adapt: typed internal workflow nodes

If workflow duplication becomes costly, introduce a small trusted internal representation such as `sequence`, `parallelReaders`, `checkpoint`, `singleWriter`, and `verifyLoop`. Validation must reject writers in parallel nodes, require approval before mutation, and preserve `routeTask()` for every child lane.

### P1 — Adapt: durable job controls

Persist bounded job descriptors—ID, role, route, read/write mode, plan ID, attempt, state, and artifact paths—without raw prompts or outputs. Read-only jobs may be retried directly; writer retries require confirmation and the one-writer guard.

### P2 — Adapt: privacy-bounded trajectory and usage

Aggregate phase timestamps, model routes, token/cost totals, and terminal states. Do not persist prompt text, tool arguments, transcripts, or source content by default.

### Residual P2 verification debt

- `tests/workflow-orchestration.test.ts` still uses a source-order assertion for the council implementation lease. The council command is registered inside the large extension initializer and has no narrow injected lease/launch seam; adding one solely for this assertion would widen the production interface. Replace this with a behavioral contention test when that command is extracted behind a naturally reusable seam.
- `/workbench-update apply` behaviorally tests successful terminal reload and rejected-reload guidance, but does not launch a second real Pi runtime to prove live extension replacement end to end. A process-level live-reload integration remains P2; reload rejection explicitly reports that the update is installed only on disk and requires `/reload` or restart.

## Explicitly rejected

- Evaluating model-authored JavaScript or shell gates as workflow definitions.
- Replacing task-based Luna/Terra/Sol routing with role-bound model defaults.
- Allowing role overlays to widen tools, write authority, model scope, or verification policy.
- Copying the upstream package split before a measured maintainability need exists.
- Automatic writer replay after interruption.
