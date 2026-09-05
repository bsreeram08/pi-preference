# Sreeram's Pi Workbench

[![CI](https://github.com/bsreeram08/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/bsreeram08/pi-workbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-FF8A4C.svg)](LICENSE)

A personal Pi profile built as a first-party [Pi](https://github.com/earendil-works/pi) workbench. Main Pi is the **Coordinator**. It clarifies intent, routes work to first-party specialists, keeps reviewed memory, and records what happened.

Interactive agents, todos, structured questions, user-owned goals, and recorded verification ship in this repository.

Do not `pi install npm:pi-workbench`. Use the recursive Git installation below; this repository keeps `private: true` to prevent accidental npm publication.

> **Pre-1.0:** interfaces and stored formats may evolve. Pi extensions run with the permissions of the user running Pi. Read [`SECURITY.md`](SECURITY.md) and the pinned RePrompter submodule before installing.

## What it is

| Layer | First-party surface | Role |
|---|---|---|
| Coordinator | Main Pi session | Routes work, reviews memory, keeps the user in the loop |
| Agents | `delegate_task`, `workbench_agent_*` | One AgentRunManager. Inside cmux, children are real Pi TUI tabs |
| Session | `workbench_todo`, `workbench_ask`, `workbench_goal` | Task list, structured questions, user-created goals |
| Continuity | `workbench_cases`, `/cases` | Intent → action → outcome → gap. Not memory |
| Memory | `workbench_memory`, `/memory` | Reviewed, fallible, isolated by default |
| Planning | `/plan`, `/start-work`, `/autopilot`, `/council` | Intent, isolated implementation, independent verification |
| Verification | `workbench_verify` | Recorded commands, exit status, output artifacts, and code fingerprints |
| Research | `/research` | Cited evidence ledger, not search-snippet authority |
| Routing | `/model-routing` | Per-lane Codex or Grok 4.6 family for **children**; Main Pi stays put |

Replaced companions: `pi-subagents`, `@capyup/pi-goal`, `@juicesharp/rpiv-todo`, `@juicesharp/rpiv-ask-user-question`. Do not enroll them. Use the first-party tools above.

Trust, child isolation, and cmux identity rules live in [`SECURITY.md`](SECURITY.md). Memory lifecycle lives in [`docs/memory.md`](docs/memory.md). The agent-runtime roadmap lives in [`docs/first-party-memory-and-agent-runtime.md`](docs/first-party-memory-and-agent-runtime.md).

## Principles

1. A rough idea is not an implementation brief.
2. The Coordinator routes by capability; a Supervisor selects specialists for council phases.
3. User decisions and their rationale are durable project knowledge.
4. Implementation starts from an approved `Intent.md` or an approved workflow plan.
5. Parallel writers use isolated Git worktrees. Persistent mutation agents stay deferred.
6. Completion needs independent review and native check receipts tied to unchanged code. A zero exit proves execution; review must still judge whether the tests cover the requested behavior.
7. Recalled memory is fallible data. Verify consequential claims against the workspace.
8. Child model routing is per lane (complexity, uncertainty, risk, breadth, verification cost). Role names do not lock a model.
9. Explicit user preferences outrank generic defaults.
10. New skills from trusted sources are staged, validated, backed up, and audit-logged.

## Requirements

- macOS, Linux, or WSL with Bash
- Git and Python 3
- Node.js 22.19 or newer
- Pi coding agent 0.84.4 or a compatible newer release
- Bun 1.3.14 and TypeScript 5.9.3 only for development or `--strict` installation

The supported distribution is a recursive Git clone: RePrompter is a pinned submodule. The installer fails closed if the submodule is missing and prints the recovery command. The root package is `private: true`.

## Install

```bash
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
git clone --recurse-submodules \
  https://github.com/bsreeram08/pi-workbench.git \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-workbench"
./install.sh
```

Default install links Workbench, the cmux companion, the framed editor, and the Ember file. It preserves the active theme, settings, preferences, and skill-evolution configuration. Replaced links roll back if a later step fails. No companion Pi packages are added.

Opinionated profile (Codex Sol/high, Ember, compact startup header, preference baseline, allowlisted skill evolution):

```bash
./install.sh --full
```

Maintainers:

```bash
bun install --frozen-lockfile
./install.sh --strict
```

After install, start Pi or `/reload`.

### Update

Interactive launch asks before applying a newer trusted `bsreeram08/pi-workbench` commit. It never silently updates.

`/workbench-update` reports status. `/workbench-update apply` revalidates and asks again. The updater fails closed on dirty trees, wrong origin, missing profile, or incomplete rollback. Details are in [`SECURITY.md`](SECURITY.md).

### Uninstall

Remove the Workbench, Pi Look, startup-header, and Ember links under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` after checking where each points. Project state and memory stay on disk.

Backups: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/backups/pi-workbench/<timestamp-pid>/`.

## Start a coding task

Run `/plan <task>`, review the acceptance criteria, then `/start-work`. The default focused execution is:

```text
Approved plan → implementer → independent technical reviewer → verifier
                              ↑         repair loop         ↓
```

Planning includes discovery and independent plan review. Execution uses one writer by default; parallel candidates are opt-in. Set `"workflowMode": "thorough"` in `.pi/pi-workbench/config.json` for a separate requirements analyst, execution manager, and dual reviews. Both modes retain approval, writer ownership, bounded repair loops, and recorded verification.

After the run, `/workflow-status` shows the state and evidence paths. Inspect `checks-N.md` and the criterion assessment, and run the relevant tests yourself. For a copyable scratch-project example and expected success, failure, and timeout results, see [Testing the harness](docs/testing-harness.md).

## Commands

| Command | Purpose |
|---|---|
| `/delegate [agent task]` | Roster, or run one specialist (`delegate_task` under the hood) |
| `/model-routing` | Child family/policy menu; `grok`/`codex`/`balanced`/`economy`/`quality`; `--default` persists |
| `/todos` | Show the first-party session todo list |
| `/goals` | Show the user-owned Workbench goal |
| `/goals-set <objective>` | Create or replace the goal. The agent does not create goals |
| `/goals-clear` | Remove the goal file |
| `/plan [task]` | Clarify, plan, and independently review acceptance criteria |
| `/start-work` | Implement, independently review, repair, and verify the approved plan |
| `/autopilot [task]` | Plan, implement, review, and verify in one run |
| `/automode [on\|off\|status]` | Keep this Coordinator session moving with conservative defaults |
| `/workflow-status` | Current plan state and evidence paths |
| `/preferences` | Durable user operating preferences |
| `/remember [preference]` | Teach an explicit preference |
| `/memory [query]` | Memory status, pending proposals, or recall |
| `/cases [status\|recall [query]]` | Continuity cases |
| `/council [idea]` | Visible council pass, then Intent.md |
| `/council-implement` | One isolated writer by default after approved intent; parallel candidates are opt-in |
| `/council-force-complete [reason]` | Recorded verification override |
| `/council-decision [decision]` | Record what the user decided and why |
| `/council-knowledge [query]` | Search QMD-indexed project knowledge |
| `/council-status` / `/council-settings` | Council state and project preferences |
| `/research [question]` | Bounded parallel research, cited report, audit |
| `/research-status` | Tracks, evidence, audit, artifact paths |
| `/research-source` / `/research-observation` | Add a source or a user-verified observation |
| `/research-synthesize` / `/research-audit` / `/research-refresh` | Rebuild, re-audit, or re-fetch |
| `/research-export` / `/research-handoff` | Export paths, or start a follow-on session |
| `/skills-evolve` | Stage trusted skill updates |
| `/skills-evolution-status` | Trusted sources and audit |
| `/workbench-update [status\|apply]` | Inspect or confirm a trusted update |
| `/usage` | Coding-plan quota for the active provider |

## First-party tools

Prefer these over leftover third-party names:

- `delegate_task` — one-shot specialist work. Read-only specialists may use Bash for inspection; writers go through the single-writer lease.
- `workbench_agent_start` / `_message` / `_status` / `_answer` / `_cancel` / `_focus` — persistent read-only agents. Inside cmux they are unfocused Pi TUI tabs (`Ctrl+Alt+A` focuses the dashboard).
- `workbench_verify` — run a verification command and retain a native process receipt.
- `workbench_todo` — session task list (`/todos`).
- `workbench_ask` — up to four structured questions when a real decision is required.
- `workbench_goal` — get/complete/pause/resume. Create with `/goals-set`.
- `workbench_cases` — retain/recall continuity.
- `workbench_memory` — reviewed durable memory.
- `ask_parent` — one child question back to the Coordinator.

Do not start new work with the external `subagent` tool or `workflowScript`.

## Live agent UI

The footer shows Supervisor and child phase cards. `Ctrl+Alt+A` toggles the dashboard, arrows navigate, `Enter` opens an overlay, `Escape` returns to the editor. Overlay input steers a running child, or answers `waiting_for_parent`. Interactive Pi TUI tabs stay immediate; they are not process-paused.

## Child model routing

Shipped default family is Codex: light Luna/low, standard Terra/medium, heavy Sol/high. `/model-routing grok` is session-only; `/model-routing grok --default` writes the project family. Main Pi does not change unless launched with `--model`.

`--default` writes `.pi/pi-workbench/config.json` at the **git project root**. Natural-language directives such as `use grok routing this session` keep the other axis (family vs policy).

GPT Luna/Sol children use priority service when `fastMode` is true (project default). Set `"fastMode": false` in project config to disable.

## Verification and child context

`workbench_verify` accepts literal `argv`, an optional project-relative `cwd`, acceptance `criterionIds`, an evidence `kind`, and a timeout. The runtime records actual exit/interruption status, private JSON/log artifacts, output digests, and before/after code fingerprints. Workflow completion additionally checks invocation/result correlation and the final workspace fingerprint. Ordinary Bash output and a model-written “passed” statement cannot replace these receipts.

Fingerprints include dirty tracked files, non-ignored untracked files, modes, symlink targets, and initialized submodules. Ignored files and Workbench runtime state are excluded; external dependencies and services are not frozen. The model receives a bounded output tail, while full output is retained privately up to the limit. This is cooperative execution evidence, not an OS sandbox or a guarantee that the selected tests are sufficient.

Children receive explicit global/project `AGENTS.md`, supported Markdown references, and task-selected installed skills while ambient extension/skill discovery remains disabled. Missing skills are reported. Routing uses the original task, independent code review omits the author's self-assessment, cases are recalled by relevance, and paused goals are excluded from active instructions.

Workbench checks Pi's project-trust decision before launching children. For an untrusted project, run `/trust` and restart Pi before launching a workflow.

## Research: current behavior and next design

`/research` currently runs parallel tracks, builds an evidence ledger, synthesizes a report, and requests an independent audit. Its prompts distinguish primary sources, reported claims, inference, conflicting evidence, and user observations.

Its current audit is limited: model-supplied provenance is not bound to recorded retrievals, bibliography references can satisfy a report-wide citation check, and unresolved source-review states can escape the deterministic audit. A research PASS is not equivalent to a native code-check receipt.

The proposed flow is **decision → research questions → recorded source retrievals → supported claims → calculations → synthesis → independent claim audit → targeted corrections**. This redesign is documented, not implemented. See [Harness evaluation](docs/harness-evaluation.md) for the evidence requirements and comparison method. Automated harness tests do not establish improved live-model output quality.

## Project files

```text
.pi/pi-workbench/
├── Intent.md
├── decisions.md
├── ImplementationPlan.md
├── session.json
├── config.json
├── goal.json
├── qmd.json
├── archive/
├── workflow/
└── research/
```

The extension is global at `~/.pi/agent/extensions/pi-workbench/`. Intent, workflow, research, and the goal file live in the project. Memory and cases live under the Pi agent directory, keyed by project.

`workflow/current.json` is the sole complete workflow authority. Packet verification combines the model's criterion assessment with native execution receipts. Child sessions and checks live privately under the Pi agent directory; research reports and ledgers are written under the project's configured research output directory. See [`SECURITY.md`](SECURITY.md).

## Remaining companions

The default installer still does not enroll companion packages. A live Pi settings file may still list optional packages that Workbench does not replace yet: Minimax MCP, `pi-lmstudio`, `@vigolium/piolium`, `context-mode`, `pi-background-tasks`, and the `diagram-design` git skill. `pi-autoresearch` and `@dietrichgebert/ponytail` stay excluded.

Validate a machine against the committed inventory:

```bash
bun run capabilities:check
```

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [Testing the harness](docs/testing-harness.md). From a recursive clone:

```bash
bun install --frozen-lockfile
bun run check
PI_CODING_AGENT_DIR="$(mktemp -d)/agent" ./install.sh --strict
```

Release gate from a clean committed tree: `bun run release-check`. After editing an installed checkout, `/reload`.

## License and support

MIT. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`SECURITY.md`](SECURITY.md), and [`SUPPORT.md`](SUPPORT.md).
