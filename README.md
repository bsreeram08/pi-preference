# Pi Workbench

A preference-aware Pi capability workbench for intent clarification, evidence-backed research, planning, delegated implementation, independent verification, durable agent memory, explicit preferences, and trusted skill evolution.

## Principles

1. A rough idea is not an implementation brief.
2. A dedicated Supervisor agent dynamically selects specialists and orchestrates every phase.
3. User decisions and their rationale are durable project knowledge.
4. Implementation happens only from an approved `Intent.md`.
5. Parallel implementation candidates work in isolated Git worktrees.
6. Completion requires independent, visible test evidence.
7. The user may override the test gate, but the override is explicitly recorded as untested.
8. Decision-grade research separates facts, reported claims, inference, and recommendations in a durable evidence ledger.
9. Search discovery is not evidence: agents inspect source pages, preserve retrieval dates, and independently audit the final report.
10. Main Pi acts as the Coordinator: it routes work by capability, and every child agent can progressively load the same installed Pi skills.
11. Explicit user preferences survive sessions and outrank generic workflow defaults.
12. New and updated skills from explicitly trusted sources are staged, validated, backed up, and audit-logged before adoption.
13. Agent memory is isolated by default, shared only through Coordinator review, provenance-aware, bounded, forgettable, and always treated as fallible data.

## Install on another machine

The canonical distribution is the private GitHub repository. Clone it directly into Pi's extension directory and run the idempotent installer:

```bash
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
git clone --recurse-submodules \
  git@github.com:bsreeram08/pi-workbench.git \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
./install.sh
```

The installer:

- links Pi Workbench, the framed editor extension, and the Ember theme;
- merges portable settings without deleting machine-specific values;
- merges the explicit preference baseline and trusted skill sources;
- preserves replaced resources as timestamped backups;
- runs the full Bun test suite, a strict TypeScript check when `tsc` is available, and main/child Pi RPC smoke tests.

Provider credentials, sessions, project runtime state, agent memory, skill-update backups, and generated knowledge are never included. Configure model authentication separately on each machine. After installation, start Pi (or run `/reload`) and run `/skills-evolve` once.

To update an installed machine:

```bash
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
git pull --ff-only
git submodule update --init --recursive
./install.sh
```

## Live agent UI

During a Workbench run, the footer shows the Supervisor and delegated agents as compact, collapsible phase cards. Use `Ctrl+Down` to focus the cards, arrows to navigate, and `Enter` to open an agent overlay. The overlay streams output and tool calls and accepts queued steering messages. `P` pauses/resumes, `C` cancels, `Shift+C` cancels all, `R` restarts eligible jobs, `F` shows files/tests, `Y` copies output, and `Escape` returns to Pi. Finished agents remain readable under `Finished (N)` until the next Workbench run.

## Commands

| Command | Purpose |
|---|---|
| `/delegate` | Show the specialist roster/current plan, or run `/delegate <agent> <task>` |
| `/plan [task]` | Interview, discover, analyze requirements, plan, and run Quality + Technical review |
| `/start-work` | Execute the approved plan through the Execution Manager, Implementer, review, fixes, and verification |
| `/autopilot [task]` | Let the Coordinator autonomously plan, implement, review, and verify a task |
| `/workflow-status` | Show current plan state and durable evidence paths |
| `/preferences` | Review/edit Pi's durable user operating preferences |
| `/remember [preference]` | Explicitly teach Pi a durable preference |
| `/memory [query]` | Show memory status/pending proposals, or recall relevant entries |
| `/skills-evolve` | Stage and validate all new/updated skills from trusted sources, then reload |
| `/skills-evolution-status` | Show trusted sources, cadence, audit, and community concept feed |
| `/council [idea]` | Run three council rounds, pause after Round 1, and draft/approve intent |
| `/research [question]` | Confirm a bounded plan, run parallel research tracks, synthesize a cited report, and audit it |
| `/research-status` | Show tracks, evidence count, audit status, providers, and artifact paths |
| `/research-source [URL] [claim]` | Retrieve and add a manually supplied source to the evidence ledger |
| `/research-observation [details]` | Record a user-verified call, quote, visit, photograph, or measurement |
| `/research-synthesize` | Rebuild and re-audit the report after adding evidence or observations |
| `/research-audit` | Re-run deterministic and independent citation/evidence audits |
| `/research-refresh [all]` | Re-fetch volatile sources, or every sourced record with `all`, and flag changed fingerprints |
| `/research-export` | Refresh the manifest and show report/evidence/audit export paths |
| `/research-handoff [next task]` | Start a focused session carrying the durable research state |
| `/council-implement` | Choose same/new session, run parallel implementation, reviews, fixes, and verification |
| `/council-force-complete [reason]` | Explicitly override verification and record the accepted risk |
| `/council-decision [decision]` | Record what the user decided and ask why |
| `/council-knowledge [query]` | Search QMD-indexed project and council knowledge |
| `/council-status` | Show current project council state |
| `/council-settings` | Edit project-scoped preferences |

## Project files

```text
.pi/pi-workbench/
├── Intent.md
├── decisions.md
├── ImplementationPlan.md
├── session.json
├── config.json
├── qmd.json
├── archive/
├── workflow/
│   ├── current.json
│   ├── plans/<timestamp>-<slug>.md
│   └── runs/<plan-id>/*.md
└── research/
    └── current.json

research/runs/<timestamp>-<slug>/
├── plan.md
├── tracks/*.md
├── evidence.jsonl
├── report.md
├── audit.md
└── manifest.json
```

The extension itself is global at `~/.pi/agent/extensions/pi-workbench/`; intent, settings, workflow history, and research state live inside each project. Protected agent memory is project-keyed but stored under the Pi agent directory.

## QMD

The first council run registers two QMD collections:

- council state: `.pi/pi-workbench/**/*.md`
- project knowledge: the project root's Markdown files

The `council_knowledge` tool is also available to the main pi agent.

## RePrompter

The vendored RePrompter checkout lives at `reprompter/`. Every specialist prompt tells the agent to apply its intent, constraints, artifact, and success-criteria discipline.

Update the pinned submodule with:

```bash
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
git submodule update --remote reprompter
git add .gitmodules reprompter
git commit -m "chore: update RePrompter"
```

## Implementation safety

Parallel workers use detached Git worktrees. `/council-implement` refuses to begin if project files outside `.pi/pi-workbench/` are dirty. Commit or stash user changes first. Council state itself may remain untracked.

Workers produce independent candidates. A separate integration implementer inspects each candidate and merges the compatible parts into the main working tree. Three reviewers run in parallel, followed by a single independent verifier that runs the project's canonical tests. Failed review or verification starts another fix loop.

Defaults in `config.json`:

```json
{
  "maxCouncilAgents": 6,
  "parallelImplementationWorkers": 3,
  "maxFixLoops": 5,
  "defaultImplementationSession": "ask",
  "qmdEnabled": true,
  "maxResearchAgents": 5,
  "researchSourcesPerTrack": 6,
  "researchOutputDir": "research",
  "researchDefaultDepth": "decision-grade",
  "researchRequirePlanConfirmation": true,
  "researchWorkerModel": "openai-codex/gpt-5.4-mini:medium",
  "researchSynthesisModel": "openai-codex/gpt-5.6-sol:high",
  "researchAuditModel": "openai-codex/gpt-5.4:high",
  "workflowMaxParallelAgents": 4,
  "workflowMaxInterviewRounds": 2,
  "workflowMaxPlanReviewLoops": 3,
  "workflowMaxFixLoops": 3,
  "workflowFastModel": "openai-codex/gpt-5.4-mini:medium",
  "workflowPlanningModel": "openai-codex/gpt-5.6-sol:high",
  "workflowDeepModel": "openai-codex/gpt-5.6-sol:medium",
  "workflowReviewModel": "openai-codex/gpt-5.6-terra:high"
}
```

## Research retrieval

Research agents have isolated contexts and read-only project tools. Their public-web tools use this fallback order:

1. Brave Search API when `BRAVE_SEARCH_API_KEY` is configured
2. Tavily when `TAVILY_API_KEY` is configured
3. Serper when `SERPER_API_KEY` is configured
4. DuckDuckGo HTML discovery fallback
5. Yahoo HTML discovery fallback
6. Bing HTML discovery fallback
7. Direct source extraction
8. Playwright/Chromium rendering for JavaScript-dependent pages

API failures and skipped providers are returned with provenance. Search snippets are for discovery only. The static and browser fetchers return retrieval metadata and SHA-256 content fingerprints; `/research-refresh` never silently rewrites claims when a source changes.

## Adaptive capability system

Pi's native skill catalogue remains the source of capabilities. Workbench child agents no longer disable skills: each specialist sees skill descriptions and reads only the matching `SKILL.md` files on demand. Routing adds three contextual concept packs:

- **Engineering** — alignment, ubiquitous language, small feedback loops, TDD, diagnosis, deep modules, and Standards-vs-Spec review.
- **Design** — Emil Kowalski's restraint, invisible edge cases, purposeful/interruptible motion, accessibility, and real-input verification for user-facing work.
- **Experimentation** — Karpathy-style fixed objectives and harnesses, baseline/measure/keep-or-revert loops, durable memory, metric integrity, simplicity, and anti-thrashing for measurable optimization.

Durable global state:

```text
~/.pi/agent/user-profile.json
~/.pi/agent/memory/pi-workbench/
~/.pi/agent/skill-evolution/config.json
~/.pi/agent/skill-evolution/state.json
~/.pi/agent/skill-evolution/audit.jsonl
~/.pi/agent/skill-evolution/backups/
~/.pi/agent/knowledge/autoresearch-community.md
```

Trusted skill evolution defaults to `mattpocock/skills` and `emilkowalski/skills` every 24 hours. Updates are installed into a temporary home first, frontmatter and size are validated, changed skills are backed up, and only then are they copied into `~/.agents/skills`. The Karpathy issue index is explicitly labeled as unverified hypothesis input; agents must validate an issue before applying it. Unknown third-party repositories are never auto-trusted.

## Workbench memory

`workbench_memory` gives the Coordinator and child agents durable, evidence-backed memory without turning recalled text into authority:

- Project scope is the default, including automatic prompt recall. Global scope accepts only reusable `learning` and `warning` entries and must be recalled explicitly.
- Every specialist has a private namespace. Automatic recall exposes only shared entries plus that specialist's own entries.
- All project-scoped memory lives under `~/.pi/agent/memory/pi-workbench/projects/<canonical-project-hash>/`, outside the child workspace. Unsafe agent-directory overlap is rejected, and the child extension blocks direct file-tool access to protected memory roots.
- Specialists can write private memory or submit `propose_shared`; only the Coordinator can inspect and promote the pending inbox.
- The Coordinator can write shared entries directly, preserve derivation/supersession links, and invalidate entries through integrity-checked tombstones.
- Volatile entries can carry `expiresAt`; stale entries are excluded from normal recall but remain auditable.
- Every entry and tombstone carries a SHA-256 checksum. Status reports altered or unreadable records instead of injecting them.
- Writes use atomic file replacement and an owner-token per-scope process lock, preserving deduplication under concurrent child processes. Abandoned locks fail closed and require deliberate operator recovery rather than unsafe automatic takeover.
- Injected context is relevance-filtered and capped at 12,000 characters. It explicitly says memory is fallible data, not executable instruction.
- Credentials, sensitive personal data, prompt-injection-shaped text, and unsafe global facts/decisions are rejected.

Explicit user operating preferences still belong in `preference_memory` and `~/.pi/agent/user-profile.json`; Workbench memory does not replace personalization. The design adapts lightweight namespace, provenance, invalidation, and retention ideas from `tickernelz/pi-memory` and Semantica without adding either package as a runtime dependency. See [`docs/memory.md`](docs/memory.md) for the full trust and lifecycle model.

## Development checks

```bash
cd ~/.pi/agent/extensions/pi-workbench
bun run test
bun run typecheck
```

After editing, run `/reload` in pi.
