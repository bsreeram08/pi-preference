# Measuring harness quality

For commands and expected outcomes, see [Test the harness improvements](testing-harness.md).

The process tests prove properties of the harness. They do not establish that a model produces better finished work with it. Do not label fixture success rates as agent-quality improvements.

Compare four configurations on the same task snapshots: Main Pi alone; Main Pi with relevant context; focused Workbench; thorough Workbench. Fix the model, reasoning level, time/tool budget, repository starting point, and installed skill revisions. Run each task more than once and rotate configuration order. Keep evaluator tests outside the writer's editable checkout.

Use real completed tasks with known expected behavior: a regression with a reproducer, an API change with error cases, a UI interaction with visual/keyboard checks, a cross-file refactor, and a research question with primary-source support. Include dirty starting trees and interruption/recovery cases. Expand the set with actual failures; reserve unseen tasks for final comparison.

For each run, retain the configuration/revision, task snapshot, elapsed time, usage, patch, native check receipts, independent evaluation outcome, human corrections, and regressions. Blind human comparison should assess visual quality and maintainability where automated tests are insufficient. Report the distribution of outcomes, not only the best run.

Promote a new skill, extra agent stage, routing rule, or context layer only after comparison demonstrates improved outcomes on relevant tasks. The present change has mechanical regression coverage; no live-model superiority result is claimed.

## Receipt design decision

Inspected `bsreeram08/pi-intent-receipt` as inspiration. Its useful distinction is between the writer's statement and an observed process result. Workbench adopts that distinction within its existing execution path. It does not adopt the fixed Grok writer, default `bun test`, mandatory clean source tree, new installation dependency, or automatic patch copy-back.

Checks are selected from the repository and acceptance criteria. The runtime records execution and code identity; an independent reviewer assesses whether those checks actually support completion. This is intentionally narrower than claiming that any command returning zero proves the product correct.

## Proposed research flow (not implemented)

Decision → research questions → recorded source retrievals → supported claims → calculations → synthesis → independent claim audit → targeted corrections.

Preserve the existing primary-source guidance, fact/inference separation, conflicting evidence, and field-observation distinction. Replace model-declared retrieval metadata with host-recorded source artifacts. Only actual user submissions can establish user verification. Bind excerpts and claim references to those artifacts; mechanical excerpt matching establishes provenance, while independent review assesses whether the source supports the claim.

Audit the report body separately from its bibliography. Resolve temporary evidence identifiers mechanically. Track unresolved, changed, and failed-refresh sources, and preserve independent audit failures until a new review resolves them. Retain counterevidence investigation in fast mode, choose tracks from the decision, and run quantitative analysis after evidence collection. Retrieve complete claim-relevant records for synthesis and review instead of silently truncating a large ledger. Report audit coverage and remaining uncertainty explicitly.

The current research tests do not establish these guarantees. Add regression cases for invented provenance, uncited numeric claims with a populated bibliography, stale sources, failed reviewers, and incomplete audit coverage before claiming this redesign is complete.
