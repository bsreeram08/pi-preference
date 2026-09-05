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

Repeat the success/failure checks in a separate small directory with no Git repository in any parent. Verification should use the bounded filesystem snapshot there. Non-Git snapshots do not honor `.gitignore`, so avoid a large dependency tree for this smoke check. Broken Git metadata should produce an error, not silently switch to the non-Git path.

## Exercise a real focused workflow

In the disposable Git project, use:

```text
/plan Add clamp(value, min, max) in clamp.mjs and Node built-in tests in clamp.test.mjs. Clamp finite numbers to inclusive bounds; preserve values already within bounds; throw RangeError when min exceeds max. Cover each behavior. No dependencies or network access are needed. Verify with node --test clamp.test.mjs.
```

Review the plan and its acceptance criteria. Then run `/start-work` and accept the execution confirmation. With the default `workflowMode: "focused"`, execution should show an implementer, one independent technical reviewer, and a separate verifier; discovery and planning may have their own agents, and failed checks can cause repair rounds.

Run `/workflow-status` and inspect the reported artifact paths. Look for `checks-N.md` containing native receipts and the corresponding criterion assessment. Confirm that the recorded argv runs the actual tests, exit status is zero, and before/after fingerprints match. Run `node --test clamp.test.mjs` yourself and inspect the assertions. Completion should reflect supported acceptance criteria, not simply a model saying “passed.”

The automated tests cover stale receipts and tampered artifacts. For a manual failure demonstration, ask the main Pi tool to run a deliberately failing test in the scratch project and confirm it produces a non-passing receipt. A full workflow may correctly repair a defect and pass later; inspect the final checks rather than expecting the entire workflow to remain failed.

## Exercise design context with a 3D resume

First run the context and launch regressions:

```sh
rtk proxy bun test tests/agent-context.test.ts tests/agent-run-manager.test.ts tests/workflow-orchestration.test.ts
```

These include a complete skill above 24,000 bytes, optional-file omissions, source precedence, and the combined budget. They establish loader behavior independently of a model run. See [Child instructions and skills](child-context.md) for the limits.

For a live check, put a copy of `resume-data.json` in a disposable project, reload the updated Workbench, and use the following prompt. Treat the JSON as private input and review it before making the resulting site public.

```text
/plan Build an interactive 3D aviation-themed portfolio from resume-data.json. Inspect the JSON and existing app first. Treat the JSON as the source of truth: do not invent employers, dates, achievements, travel history, or locations. Use a small airplane and flight paths to navigate between career chapters; flight routes are a visual metaphor unless the data explicitly supports real locations. Keep resume content readable in accessible HTML alongside the 3D scene. Support keyboard navigation, mobile touch, reduced motion, and a useful fallback when WebGL is unavailable. Use emil-design-eng and animate guidance if installed and available to the assigned role. Propose the visual direction, dependencies, acceptance criteria, and concrete checks before implementation. Verify the build and key interactions, and inspect desktop and mobile rendering with browser tooling if available. Report any checks you cannot perform.
```

Review the plan, then run `/start-work`. Check two separate outcomes:

- **Context and workflow:** planning launches without the former skill-size error. The child context identifies supplied skills and explains omissions. Check actual context/session artifacts rather than accepting a model's claim that it used a skill. Review `/workflow-status` and native check evidence.
- **Finished product:** resume facts match the JSON, career sections are reachable with a keyboard, mobile text remains readable, reduced motion avoids unnecessary flight animation, and the fallback retains the resume. Inspect the actual rendered site and interactions; a successful build cannot establish visual quality or accessibility by itself.

If browser tooling is unavailable, record visual and interaction checks as unverified and perform them manually. One attractive result does not establish that the harness improves model quality; use the repeated comparisons in [Harness evaluation](harness-evaluation.md).

If planning fails before implementation, follow [Workflow troubleshooting](troubleshooting.md) before retrying. The update-marker error and the optional-skill loader error have separate causes.

## Research checks

Run the provenance and audit regressions:

```sh
rtk proxy bun test tests/research-provenance.test.ts
```

In Pi, use `/research` for a narrow question with accessible official sources. Inspect the report, `evidence.jsonl`, and `sources/*.json` under the reported run directory. Every sourced factual record should identify a saved artifact, a matching excerpt, and an actual retrieval timestamp. An inaccessible page or mismatched excerpt must remain unverified and prevent a clean audit.

In a disposable research run, use `/research-refresh all`: even unchanged pages require a new independent audit, and a prior failure must remain unresolved. Use `/research-source` to explicitly review and re-baseline changed source claims, followed by `/research-synthesize` or `/research-audit`. Only `/research-observation` submissions can establish user verification. Old ledgers without source artifacts need this explicit review before passing.

The regression tests also alter source artifacts and insert invented provenance, bibliography-only citations, unresolved refresh failures, and conflicting audit verdicts. Each must fail the relevant gate. Run these offline tests rather than corrupting a useful research run. A clean audit still depends on the reviewer's judgment of source authority and claim support; live-model comparisons remain to be measured.
