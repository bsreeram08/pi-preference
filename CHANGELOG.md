# Changelog

## Unreleased

- Adapted selected AgentMemory concepts into the existing local Workbench store: deterministic weighted recall with diagnostics, integrity-checked explicit-access sidecars, review-gated derived consolidation proposals, and versioned dry-run/review/apply memory transfer. No AgentMemory/iii runtime, daemon, network provider, automatic capture/consolidation, or second memory injection path was added.
- Added a committed validate-only capability manifest for nine packages, four extensions, and Ember, with hard runtime exclusions for `pi-autoresearch` and `@dietrichgebert/ponytail`; the checker reports drift without installing, removing, enabling, starting, loading, or fetching resources.
- Added focused memory ranking/access/consolidation/import safety tests, including process-kill visibility recovery and exact-shape rejection, plus capability schema/drift/exclusion/path-binding/no-mutation tests.
- Added an opt-in π/SREE startup header with concise skill, prompt, and tool counts to the full Ember profile.
- Enabled Pi's quiet startup mode in the full profile so verbose resource lists stay hidden while diagnostics remain visible.
- Added `/usage` for on-demand OpenAI Codex coding-plan quota, remaining percentages, plan tier, and reset times.
- Added secret-safe parsing and request failures with no background polling or persisted provider quota data.
- Retry `/usage` once after a transient network failure while preserving the existing request timeout and cancellation behavior.

## 0.4.1 — 2026-08-18

- Prepared the project for public release as **Sreeram's Pi Workbench** under the MIT License, with third-party notices, security/support/conduct policies, contribution guidance, and GitHub issue/PR templates.
- Set the canonical public repository to `bsreeram08/pi-preference` while retaining stable `pi-workbench` package and installation identifiers.
- Added pinned development dependencies, a Bun lockfile, and least-privilege Ubuntu/macOS CI with full-SHA action pinning, tests, strict typechecking, shell checks, and isolated installer integration.
- Changed a missing skill-evolution configuration to fail safe with automatic network synchronization disabled; `/skills-evolve` remains an explicit one-time action and `--full` opts into the allowlisted periodic profile.
- Made the default installer non-invasive to settings, preferences, active theme, and skill configuration; the opinionated profile now requires `--full`.
- Moved installer validation before mutation, added fail-closed JSON and symlink checks, byte-for-byte configuration backups, link rollback, unique backup paths, and strict validation mode.
- Made trusted skill batches transactional: all candidates validate and back up before mutation, provenance commits atomically, failures roll back, malformed locks fail closed, and owner-token locks are never taken over automatically.
- Added a mandatory clean-tree, full-history release gate for secret patterns, noreply commit metadata, submodule integrity, licensing, and pinned CI actions.
- Removed floating companion package and provider/model defaults from the portable settings baseline.

## 0.4.0 — 2026-08-18

- Added native `workbench_memory` and `/memory` with project/global scopes, private per-agent namespaces, shared memory, and a Coordinator-reviewed proposal inbox.
- Added automatic role-scoped recall to Coordinator and child-agent prompts; child identity is attributed through `PI_WORKBENCH_AGENT`, temporary worktrees and symlinked paths use one canonical project memory root, and all memory state stays outside child workspaces behind direct-access guards.
- Added immutable per-entry JSON, SHA-256 integrity checks, derivation/supersession links, optional expiry, stale-entry filtering, integrity-checked tombstones, and bounded context injection.
- Added secret, sensitive-personal-data, prompt-injection, invalid-global-kind, ID, timestamp, and lineage-limit rejection.
- Added owner-token per-scope process locks, atomic writes, fail-closed abandoned-lock handling, idempotent promotion, and cross-process deduplication.
- Added focused tests for isolation, proposal/promotion review, global restrictions, safety rejection, tombstones, stale and superseded recall, context bounds, fail-closed lock handling, deduplication, integrity failure, and concurrent processes.
- Added a portable strict TypeScript check plus stronger main/child RPC installer smoke gates.
- Documented the memory trust model and the lightweight concepts adapted from `tickernelz/pi-memory` and Semantica; neither project is installed as a runtime dependency.

## 0.3.0 — 2026-08-18

- Added functionally named Pi workflow roles: Coordinator, Planner, Requirements Analyst, Quality Reviewer, Technical Reviewer, Execution Manager, Implementer, Task Implementer, Codebase Explorer, and Researcher.
- Added `/plan`, `/start-work`, `/autopilot`, `/delegate`, and `/workflow-status`.
- Added `delegate_task` for named single delegation and race-safe parallel read-only delegation.
- Added bounded planning interviews, mandatory requirements analysis, dual plan review, execution briefs, implementation/fix loops, and an independent verification gate.
- Added durable workflow plans and run evidence under `.pi/pi-workbench/workflow/`.
- Enabled progressive Pi skill loading in all Workbench child agents instead of launching them with skills disabled.
- Added contextual engineering, design-craft, and measurable-experiment concept routing inspired by Matt Pocock, Emil Kowalski, and Karpathy autoresearch.
- Added `/preferences`, `/remember`, and `preference_memory` for explicit durable user personalization with secret rejection.
- Added trusted skill evolution with temporary staging, validation, backups, audit logs, and a clearly untrusted Karpathy issue hypothesis feed.
- Changed all remaining Pi accent lines to `#FF8A4C` and made context pressure green below 60%, yellow at 60–84%, and red at 85%+.

## 0.2.0 — 2026-08-18

- Added `/research` with confirmed fast or decision-grade plans.
- Added isolated parallel market, technical, and general research profiles.
- Added `deep_research` for automatic invocation from natural-language research requests.
- Added Brave, Tavily, and Serper API routing with DuckDuckGo, Yahoo, and Bing HTML fallbacks.
- Added direct public-source extraction and Playwright/Chromium rendering with content fingerprints.
- Added durable per-run plans, track reports, `evidence.jsonl`, cited synthesis, independent audit, and manifest.
- Added `/research-status`, `/research-source`, `/research-observation`, `/research-synthesize`, `/research-audit`, `/research-refresh`, `/research-export`, and `/research-handoff`.
- Added research-aware context injection after long-session compaction.
- Added configurable model routing: lower-cost workers, stronger synthesis, and independent audit.
- Added evidence validation, URL canonicalization, source-diversity checks, conflict references, and volatile-source refresh handling.
- Expanded the Pi Workbench test suite and added RPC, browser, search-fallback, child-agent, and full end-to-end smoke validation.
