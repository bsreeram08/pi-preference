# Test the harness improvements

## Automated regression checks

From the Workbench checkout, with its dependencies and Pi installed:

```sh
rtk proxy bun run check
```

This runs public-release checks, the full test suite, and strict TypeScript checking. The suite includes real subprocess checks for success, nonzero exit, timeout, cancellation, code changes, and altered evidence artifacts; workflow fixtures also exercise missing receipts and the focused three-role execution sequence. These establish harness behavior, not model quality.

For a shorter verification-focused run:

```sh
rtk proxy bun test tests/verification.test.ts tests/agent-context.test.ts tests/workflow-task-packet.test.ts tests/workflow-orchestration.test.ts
```

## Check the loaded Pi tool

Use a disposable Git project and start Pi there. In an existing Pi session, run `/reload` to load the updated extension. Trust the scratch project if Pi requests it; restart Pi after saving a new trust decision.

Ask Pi:

> Call workbench_verify with argv ["node", "-e", "process.exit(0)"], criterionIds ["tool-smoke"], and kind "runtime-observation". Show the receipt and output artifact path. This is only a tool smoke check, not proof of a feature.

Expect `Check exited zero on unchanged code`, an exit code of 0, a receipt ID, and a private output artifact path. Then repeat with `process.exit(7)` and expect `Check did not pass` with exit code 7. The tool may successfully return a receipt for a failed command; that is the intended behavior.

For a timeout, request argv `["node", "-e", "setInterval(() => {}, 1000)"]` with `timeoutMs: 100`. Expect a non-passing, interrupted receipt. Do not use a successful smoke command as evidence that real acceptance criteria are met.

## Exercise a real focused workflow

In the disposable Git project, use:

```text
/plan Add clamp(value, min, max) in clamp.mjs and Node built-in tests in clamp.test.mjs. Clamp finite numbers to inclusive bounds; preserve values already within bounds; throw RangeError when min exceeds max. Cover each behavior. No dependencies or network access are needed. Verify with node --test clamp.test.mjs.
```

Review the plan and its acceptance criteria. Then run `/start-work` and accept the execution confirmation. With the default `workflowMode: "focused"`, execution should show an implementer, one independent technical reviewer, and a separate verifier; discovery and planning may have their own agents, and failed checks can cause repair rounds.

Run `/workflow-status` and inspect the reported artifact paths. Look for `checks-N.md` containing native receipts and the corresponding criterion assessment. Confirm that the recorded argv runs the actual tests, exit status is zero, and before/after fingerprints match. Run `node --test clamp.test.mjs` yourself and inspect the assertions. Completion should reflect supported acceptance criteria, not simply a model saying “passed.”

The automated tests cover stale receipts and tampered artifacts. For a manual failure demonstration, ask the main Pi tool to run a deliberately failing test in the scratch project and confirm it produces a non-passing receipt. A full workflow may correctly repair a defect and pass later; inspect the final checks rather than expecting the entire workflow to remain failed.

## Research checks

Run the provenance and audit regressions:

```sh
rtk proxy bun test tests/research-provenance.test.ts
```

In Pi, use `/research` for a narrow question with accessible official sources. Inspect the report, `evidence.jsonl`, and `sources/*.json` under the reported run directory. Every sourced factual record should identify a saved artifact, a matching excerpt, and an actual retrieval timestamp. An inaccessible page or mismatched excerpt must remain unverified and prevent a clean audit.

In a disposable research run, use `/research-refresh all`: even unchanged pages require a new independent audit, and a prior failure must remain unresolved. Use `/research-source` to explicitly review and re-baseline changed source claims, followed by `/research-synthesize` or `/research-audit`. Only `/research-observation` submissions can establish user verification. Old ledgers without source artifacts need this explicit review before passing.

The regression tests also alter source artifacts and insert invented provenance, bibliography-only citations, unresolved refresh failures, and conflicting audit verdicts. Each must fail the relevant gate. Run these offline tests rather than corrupting a useful research run. A clean audit still depends on the reviewer's judgment of source authority and claim support; live-model comparisons remain to be measured.
