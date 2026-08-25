# `pi-extensible-workflows` comparison

> Reviewed: 2026-08-25  
> Scope: workflow composition, routing, lifecycle, observability, persistence, and safety

## Sources

- [`vekexasia/pi-extensible-workflows` README](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/README.md)
- [`package.json`](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/package.json)
- [Repository tree](https://api.github.com/repos/vekexasia/pi-extensible-workflows/git/trees/main?recursive=1)
- [Repository metadata](https://api.github.com/repos/vekexasia/pi-extensible-workflows)

The comparison used three independent source-grounded candidate reviews. The automated Fusion evaluator failed before producing a final merged report, but its preserved partial evaluation agreed on the main conclusions below. Claims that could not be verified beyond upstream documentation are labeled as documented rather than implementation-proven.

## Comparison

| Area | `pi-extensible-workflows` | Pi Workbench | Decision |
|---|---|---|---|
| Composition | Documents reusable `agent`, `parallel`, `pipeline`, `withWorktree`, `checkpoint`, and `defineWorkflowFunction` primitives, including model-authored JavaScript workflows. | Uses a trusted, purpose-built sequence in `workflow.ts`: discovery, requirements, reviewed plan, approval, single-writer execution, review/fix loops, and independent verification. | **Adapt typed internal primitives later; reject arbitrary generated code execution.** |
| Routing | Documents model aliases and role files that can carry model/tool/policy settings. The reviewed sources do not establish task-difficulty classification. | `routing.ts` classifies complexity, uncertainty, risk, breadth, and verification cost, then selects Luna, Terra, or Sol. Role is only a prior. | **Keep Workbench task-based routing.** |
| Writer safety | Provides `withWorktree()`, but the reviewed documentation does not establish a universal one-writer invariant. | Parallel normal delegation is read-only; mutation runs alone or in isolated worktrees with a single integrator. | **Keep Workbench’s stricter invariant.** |
| Checkpoints | Provides a reusable approval checkpoint primitive. | Has explicit plan approval and verification gates embedded in the workflow. | **Adapt a typed checkpoint representation only if it reduces duplication without weakening gates.** |
| State and resume | Describes deterministic, resumable workflows and durable inspect/stop/retry controls. The supplied sources do not expose enough implementation detail to verify replay safety. | Persists plan status, attempts, and artifacts, but lacks a safe phase-level resume path after interruption. | **Largest worthwhile future gap: crash-safe phase journaling with writer reconciliation.** |
| Observability | Documents live workflow trees, costs, trajectory/Gantt views, and steer/stop controls. | Has dashboard state, route receipts, artifacts, Pi subagent controls, and cmux status, but no unified privacy-bounded lifecycle stream or durable trajectory. | **Adopt a small metadata-only event contract; avoid transcript/tool-input telemetry.** |
| Architecture | Uses a multi-package workspace with core, CLI, and extension packages. | Uses one extension repository split into focused TypeScript modules. | **Do not migrate package structure without a concrete scaling problem.** |

## Adopted in this change

1. **Metadata-only lifecycle contract**
   - `workflow.ts` now emits `pi-workbench:task-state:v1` with bounded task title, phase detail, progress, terminal state, and no prompts, tool inputs, or outputs.
   - `setup/cmux-workbench.ts` consumes this owned contract plus explicit `pi-subagents` and background-task terminal events.

2. **Separate observability adapter**
   - The repository-owned cmux companion updates title, description, status, progress, and sparse logs.
   - It does not edit or duplicate cmux’s generated `cmux-session.ts` feed bridge.

3. **Lifecycle compatibility tests**
   - Tests cover explicit cmux targeting, state ordering, text bounds, notification deduplication, absent-cmux failure behavior, task-based routes, installer rollback, and capability inventory.

## Recommended follow-up

### P0 — Adapt: crash-safe phase journal and safe resume

Extend `workflow-state.ts` with the current phase, review/fix cycle, last completed step, artifact references, repository fingerprint, and explicit `interrupted`/`cancelled` states. Persist state atomically. A resume command must:

- verify the plan and repository fingerprint;
- skip completed read-only phases only when their artifacts still validate;
- never replay a partially completed writer automatically;
- require user confirmation and working-tree reconciliation before writer retry.

This should be a separate change because it alters execution semantics and needs interruption-focused tests.

### P1 — Adapt: typed internal workflow nodes

If workflow duplication becomes costly, introduce a small trusted internal representation such as `sequence`, `parallelReaders`, `checkpoint`, `singleWriter`, and `verifyLoop`. Validation must reject writers in parallel nodes, require approval before mutation, and preserve `routeTask()` for every child lane.

### P1 — Adapt: durable job controls

Persist bounded job descriptors—ID, role, route, read/write mode, plan ID, attempt, state, and artifact paths—without raw prompts or outputs. Read-only jobs may be retried directly; writer retries require confirmation and the one-writer guard.

### P2 — Adapt: privacy-bounded trajectory and usage

Aggregate phase timestamps, model routes, token/cost totals, and terminal states. Do not persist prompt text, tool arguments, transcripts, or source content by default.

## Explicitly rejected

- Evaluating model-authored JavaScript or shell gates as workflow definitions.
- Replacing task-based Luna/Terra/Sol routing with role-bound model defaults.
- Allowing role overlays to widen tools, write authority, model scope, or verification policy.
- Copying the upstream package split before a measured maintainability need exists.
- Automatic writer replay after interruption.
