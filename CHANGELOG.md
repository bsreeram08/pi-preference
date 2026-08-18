# Changelog

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
