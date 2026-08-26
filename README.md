# Sreeram's Pi Workbench

[![CI](https://github.com/bsreeram08/pi-preference/actions/workflows/ci.yml/badge.svg)](https://github.com/bsreeram08/pi-preference/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-FF8A4C.svg)](LICENSE)

A preference-aware [Pi](https://github.com/earendil-works/pi) capability workbench for intent clarification, evidence-backed research, planning, delegated implementation, independent verification, durable agent memory, explicit preferences, and trusted skill evolution.

> **Pre-1.0:** interfaces and stored formats may evolve. Pi extensions execute with the permissions of the user running Pi. Review the source, [`SECURITY.md`](SECURITY.md), and the pinned RePrompter submodule before installation.

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
14. Model routing is decided per task lane from complexity, uncertainty, risk, breadth, and verification cost; role names never lock a task to one model.

## Requirements

- macOS, Linux, or WSL with Bash
- Git and Python 3
- Node.js 22.19 or newer
- Pi coding agent 0.84.2 or a compatible newer release
- Bun 1.3.14 and TypeScript 5.9.3 only for development or `--strict` installation validation

The supported distribution is a recursive Git clone because RePrompter is a pinned submodule. The installer does not fetch a missing submodule: it fails before mutation and prints the explicit recovery command. The root package remains `private: true` to prevent accidental npm publication.

Optional capabilities use tools already available to Pi or explicitly invoked by the user: QMD for semantic project indexes, Playwright/Chromium for JavaScript-rendered research sources, provider-specific research API keys, and `npx`/`gh` during `/skills-evolve`. Core planning and memory do not install those integrations automatically.

## Install

Clone over public HTTPS directly into Pi's extension directory:

```bash
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
git clone --recurse-submodules \
  https://github.com/bsreeram08/pi-preference.git \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
./install.sh
```

The safe default installer:

- validates the submodule and Pi RPC imports before changing the installation;
- links Workbench, the cmux companion, the framed editor extension, and the Ember theme file;
- preserves the current active theme, settings, preferences, and skill-evolution configuration;
- backs up replaced resources and rolls links back if installation fails;
- runs Bun tests and strict TypeScript checks when those tools are available.

To opt into Sreeram's complete opinionated profile—Main Pi on OpenAI Codex GPT-5.6 Sol/high, compact π/SREE startup art, concise capability counts, Ember activation, status line, explicit preference baseline, and allowlisted periodic skill evolution—run:

```bash
./install.sh --full
```

Existing JSON values win except for the explicitly requested OpenAI Codex provider, GPT-5.6 Sol model, high thinking level, and Ember theme. Every modified existing configuration file receives a timestamped byte-for-byte backup. Malformed or symlinked configuration fails closed before installation changes anything. The installer also refuses to replace the primary checkout when invoked from a linked worktree whose Git metadata lives inside that checkout; switch the primary checkout to the desired branch and install there instead. No companion Pi packages are added automatically.

Maintainers and contributors should require every development check:

```bash
bun install --frozen-lockfile
./install.sh --strict
```

Provider credentials, sessions, project runtime state, agent memory, update backups, and generated knowledge are never distributed. Configure model authentication separately. Automatic skill evolution is disabled without explicit configuration; `/skills-evolve` performs a user-requested one-time sync.

After installation, start Pi or run `/reload`. Every successful installer run records the explicitly selected `default` or `full` profile in `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/update/pi-workbench/profile.json`; the updater never guesses a missing legacy value.

### Validate the approved capability inventory

The committed [`setup/capabilities.v1.json`](setup/capabilities.v1.json) describes the approved nine packages, four auto-discoverable extensions, Ember theme, and hard runtime exclusions for `pi-autoresearch` and `@dietrichgebert/ponytail`. It records policy; it is not an installer and does not change `setup/defaults/settings.json`.

```bash
bun run capabilities:check
# or: python3 scripts/check-capabilities.py --agent-dir /path/to/pi/agent --json
```

The checker reads only the manifest and allowlisted capability metadata in `settings.json`, `npm/package.json`, `npm/package-lock.json`, managed package manifests, and top-level extension/theme directories. It never loads code, contacts a network, invokes a package manager, or reads authentication/provider/session files. Exit `0` means the configured package sources, locked and installed package identities, discoverable extension/theme names, approved symlink targets, and exclusions match the committed inventory; `1` means deterministic drift (including an excluded runtime package), and `2` means state could not be established safely. Explicit extension/theme source settings are treated as drift because this inventory relies on the approved discoverable resources and links. It does not validate extension syntax, Pi resource declarations, theme schemas, or successful loading in an already-running process. Checking never installs, removes, enables, starts, or fetches a capability. Autoresearch skills stored outside the excluded auto-loading runtime package/extension remain untouched.

### Update

Run `/workbench-update` (or `/workbench-update status`) to perform a manual status check. It reports the current commit/version, selected stable release (or the one-time `main` bootstrap channel when no stable release exists), install profile, and a categorical blocked/no-update/update-available result. One successful `main-bootstrap` is persisted in the bounded private audit ledger; later empty-release checks return `BOOTSTRAP_CONSUMED` without fetching or applying another main commit, while a later stable release still wins. Malformed, symlinked, non-private, or oversized bootstrap audit state blocks. The updater never polls in the background.

Run `/workbench-update apply` to recompute status, review the old/new commits and channel/profile, and explicitly confirm the update. The updater accepts only a clean writable recursive clone attached to `main` with the exact trusted HTTPS origin, exact top-level `reprompter` submodule layout and Git metadata, and unchanged installer-managed links. `startup-header.ts` is always required as an immutable candidate blob; runtime link checks cover the full profile and an exact repository-managed link retained after switching to default, while a fresh default install may omit it and foreign startup paths remain user-owned. Every Git command runs with isolated configuration and replacement/attribute protections. It fetches only the selected release tag—or hardcoded `main` during bootstrap—into a private ref, validates and fast-forwards to the immutable candidate commit SHA, derives the candidate submodule gitlink strictly from that commit, and simulates the candidate config installer against the private original backup before running the live recorded profile. A successful live installer must reproduce every simulated managed file exactly; unchanged required values are not accepted as success. Before checkout mutation it verifies a complete private copy beside the resolved checkout on the same filesystem. Rollback preserves the entire failed candidate checkout and restores the old checkout with atomic no-replace directory renames; replaced deterministic config values are renamed into recovery storage before original bytes are installed without replacement. Unknown concurrent paths or values are never overwritten and produce `ROLLBACK_INCOMPLETE`; bounded fingerprints also detect ignored credential/runtime changes while excluding declared rebuildable cache trees. Verified success reports `UPDATED` before attempting one terminal Pi reload. If live reload is rejected, the update remains installed on disk and Pi must be restarted or reloaded manually. Missing or malformed profile markers block; rerun `./install.sh` or `./install.sh --full` once to record the desired profile.

Update manifests and config recovery values are retained under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/backups/update/`; failed candidate checkouts are retained at the private recovery location recorded in the manifest. Recovery paths are not printed in audit records or command UI. Any failure after backup triggers rollback and never reloads. `ROLLBACK_INCOMPLETE` requires manual inspection of the reported backup before another attempt. Cooperating workflows and updates coordinate through a short global gate, a long-lived `update.lock`, and deterministic per-canonical-project markers in a private `writers/` directory under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/update/pi-workbench/`. The gate is held only while checking and creating markers, so distinct projects can write concurrently when no update exists. Every existing live, stale, malformed, or ambiguous artifact blocks and is never taken over automatically. This remains cooperative same-user coordination, not an OS lock against arbitrary processes.

### Uninstall or restore

Remove only the Workbench, Pi Look, startup-header, and Ember symlinks under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` after verifying where each points. Workbench deliberately leaves project state and memory intact so uninstalling cannot destroy user data.

Installer backups are stored under:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/backups/pi-workbench/<timestamp-pid>/
```

Inspect a backup before copying its `resources/` or `config/` files back into the corresponding Pi agent paths.

## Live agent UI

During a Workbench run, the footer shows the Supervisor and delegated agents as compact, collapsible phase cards. Use `Ctrl+Alt+Down` to focus the cards, `Ctrl+Alt+Up` to return to the editor, arrows to navigate, and `Enter` to open an agent overlay. The overlay streams output and tool calls and accepts queued steering messages. `P` pauses/resumes, selected-child `C` cancels only that child, and `Shift+C` first aborts the confirmed `/plan`, `/start-work`, or `/autopilot` run and then cancels its active children. `R` restarts eligible jobs, `F` shows files/tests, `Y` copies output, and `Escape` returns to Pi. Finished agents remain readable under `Finished (N)` until the next Workbench run.

## Commands

| Command | Purpose |
|---|---|
| `/delegate` | Show the specialist roster/current plan, or run `/delegate <agent> <task>`; write-capable specialists now require interactive approval before launch |
| `/model-routing [status\|balanced\|economy\|quality\|fixed <model-or-alias>\|reset]` | Show or change the session-only child-routing policy without writing global model settings |
| `/plan [task]` | Interview, discover, analyze requirements, plan, and run Quality + Technical review |
| `/start-work` | Execute the approved plan through the Execution Manager, Implementer, review, fixes, and verification |
| `/autopilot [task]` | Let the Coordinator autonomously plan, implement, review, and verify a task |
| `/workflow-status` | Show current plan state and durable evidence paths |
| `/preferences` | Review/edit Pi's durable user operating preferences |
| `/remember [preference]` | Explicitly teach Pi a durable preference |
| `/memory [query]` | Show memory status/pending proposals, or recall relevant entries |
| `/skills-evolve` | Stage and validate all new/updated skills from trusted sources, then reload |
| `/workbench-update [status\|apply]` | Manually inspect or explicitly confirm a trusted built-in update |
| `/skills-evolution-status` | Show trusted sources, cadence, audit, and community concept feed |
| `/usage` | Show remaining coding-plan usage and reset times for the active provider |
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

## Coding-plan usage

`/usage` resolves the active provider through Pi and fetches quota only when the command is run. For OpenAI Codex subscription auth it shows the plan tier, availability, remaining and used percentages, and local reset times for every returned window, including model-specific limits.

Unsupported providers return a clear message. Workbench does not poll in the background, persist quota responses, or display/store provider credentials. The command depends on the provider's authenticated usage endpoint and reports a secret-safe error if that endpoint is unavailable or the login has expired.

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

The extension itself is global at `~/.pi/agent/extensions/pi-workbench/`; intent, settings, workflow history, and research state live inside each project. Protected agent memory is project-keyed but stored under the Pi agent directory. Workflow `current.json` remains the complete authoritative state: validated saves serialize per project and atomically replace the plan projection before replacing `current.json`; malformed or unsafe authoritative state is reported as corruption rather than treated as absent. Confirmation-gated workflow and council commands compare an ephemeral in-memory authority snapshot immediately before launching work or changing persisted state; a mismatch launches nothing and requires a fresh run and confirmation. There is no automatic recovery, replay, or resume path.

Write-capable workflow entrypoints first hold `.pi/pi-workbench/writer.lock`, keyed by the canonical resolved project/worktree root, then register that root under the global update coordination gate before launching children. Existing live, stale, ambiguous, or malformed project, gate, update, or writer artifacts block immediately and are never automatically removed or taken over. Independent roots remain concurrently writable when no update marker exists. Operator intervention must verify the owner before removing an abandoned artifact.

## QMD

The first council run registers two QMD collections:

- council state: `.pi/pi-workbench/**/*.md`
- project knowledge: the project root's Markdown files

The `council_knowledge` tool is also available to the main pi agent.

## RePrompter

The pinned RePrompter submodule lives at `reprompter/`. Every specialist prompt tells the agent to apply its intent, constraints, artifact, and success-criteria discipline. Its upstream MIT notice is preserved in `reprompter/LICENSE` and summarized in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

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
  "workflowReviewModel": "openai-codex/gpt-5.6-terra:high",
  "modelRoutingPolicy": "balanced"
}
```

`modelRoutingPolicy` is the durable project default and accepts `balanced`, `economy`, or `quality`; the shipped default is balanced. The older `workflowFastModel`, `workflowPlanningModel`, `workflowDeepModel`, and `workflowReviewModel` keys remain normalized for backward-compatible project files, but workflow delegation now routes each lane from the task rather than assigning models by role. Research model keys retain their existing subsystem behavior. Model identifiers are routing defaults, not bundled credentials.

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

Pi's native skill catalogue remains the source of capabilities. Workbench child agents no longer disable skills: each specialist sees skill descriptions and reads only the matching `SKILL.md` files on demand.

Adaptive model routing uses a compact three-effort interface. Under balanced routing, light tasks use `openai-codex/gpt-5.6-luna:low`, standard tasks use `openai-codex/gpt-5.6-terra:medium`, and heavy tasks use `openai-codex/gpt-5.6-sol:high`. Economy keeps Luna for light work, Spark for standard work, and Terra for heavy work; quality uses Terra for light work and Sol/high for standard or heavy work. Visual/image/UI/rendering work never uses Spark. Read-only children receive enforced stop-and-synthesize budgets of 8 turns/30 tools, 16/60, or 30/120; Workbench blocks excess tool calls and allows one final synthesis turn, while mutation-capable workers remain uncapped.

The opinionated `./install.sh --full` profile also makes Main Pi default to `openai-codex/gpt-5.6-sol` with high thinking. It transactionally backs up and replaces only the active provider/model/thinking defaults and theme while preserving unrelated settings. Use `/model-routing` for status or a session-only child override; fixed aliases are `spark`, `luna`, `terra`, and `sol`, and explicit fixed routes must use an available `openai-codex/<model>[:low|medium|high]` registry entry (an omitted suffix becomes `:medium`). Exact standalone directives such as `use sol for everything` or `use sol for everything this session` set a fixed route for delegated children. The state and receipts are persisted as TUI-only custom session entries, never added to model context, so new sessions return to the durable project policy. A fixed child route does not mutate Main Pi's current model. Both native `pi-subagents` and `delegate_task` receive compact routing guidance and pre-launch receipts. Workbench does not parse or rewrite `workflowScript` source.

### cmux task surfaces

The installer links a repository-owned `cmux-workbench.ts` companion beside cmux's generated `cmux-session.ts`; it never edits or duplicates the generated hook/feed bridge. Inside cmux, Pi uses a versioned metadata-only lifecycle contract with fixed categorical phase titles, states, progress, descriptions, and error codes. Prompts, tasks, outputs, summaries, raw errors, details, labels, and tool names are not accepted by that contract or forwarded into cmux commands. Explicit workspace/surface IDs prevent focus-dependent routing, command arguments are spawned without a shell, updates serialize, deduplication is bounded, and missing cmux state fails soft.

The generated cmux extension remains the single owner of ordinary parent completion notifications. The companion adds deduplicated notifications only for explicit subagent needs-attention/supervisor requests, failed asynchronous/background work, and terminal Workbench command outcomes. Routine child completion, process-terminal telemetry, and `SubagentStop` feed events never notify.

Routing also adds three contextual concept packs:

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

Trusted skill evolution is disabled when no explicit configuration exists. The `--full` profile can opt into an allowlist containing `mattpocock/skills` and `emilkowalski/skills` with a 24-hour cadence; `/skills-evolve` triggers a one-time user-requested sync. Updates are installed into a temporary home first, frontmatter and size are validated, changed skills are backed up, and only then are they copied into `~/.agents/skills`. The Karpathy issue index is explicitly labeled as unverified hypothesis input; agents must validate an issue before applying it. Unknown third-party repositories are never auto-trusted.

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
- Injected context uses fixed deterministic summary/evidence/metadata weights and stable tie-breakers, and remains capped at 12,000 characters. It explicitly says memory is fallible data, not executable instruction.
- Explicit Coordinator and specialist recall records integrity-checked count/time/query-hash sidecars; automatic prompt recall never writes access data or ranks by popularity.
- Derived consolidation is an explicit 2–12-source pending proposal from current, non-superseded visible memories. It never captures transcripts, runs an LLM, or supersedes sources before Coordinator review.
- Versioned structured export and dry-run import validate exact record shapes, record/bundle checksums, safety, bounds, conflicts, and project-root rebinding. Only the Coordinator can stage, approve, and separately apply merge-only imports; a durable transaction barrier keeps interrupted imports hidden until one atomic commit marker exists.
- Credentials, sensitive personal data, prompt-injection-shaped text, and unsafe global facts/decisions are rejected on normal writes and import.

Explicit user operating preferences still belong in `preference_memory` and `~/.pi/agent/user-profile.json`; Workbench memory does not replace personalization. The design adapts lightweight namespace, provenance, invalidation, retention, access-diagnostic, explicit-consolidation, and reviewed-transfer concepts from inspected primary sources without adding their runtime stacks. In particular, AgentMemory's iii engine, daemon/port, automatic capture/consolidation, network provider, and extra injection behavior are rejected. See [`docs/memory.md`](docs/memory.md) for the full trust, citations, and lifecycle model.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow. From a recursive clone:

```bash
bun install --frozen-lockfile
bun run check
PI_CODING_AGENT_DIR="$(mktemp -d)/agent" ./install.sh --strict
```

Before changing repository visibility or cutting a release, commit all intended changes and run the mandatory history-aware gate:

```bash
bun run release-check
```

After editing an installed checkout, run `/reload` in Pi.

## License and support

Sreeram's Pi Workbench is available under the [MIT License](LICENSE). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`SECURITY.md`](SECURITY.md), and [`SUPPORT.md`](SUPPORT.md).
