# First-party memory and interactive-agent roadmap

> Status: architecture exploration plus the first Agent Runtime implementation slice. No external reference package was installed or executed. Session Observations, cmux child surfaces, persistent mutation agents, and final third-party package removal remain future slices.
> Reference snapshots: `pi-observational-memory@78a1efcfdd46`, `pi-interactive-subagents@c3e8b53c0754`, and its cited upstream cmux adapter at `HazAT/pi-interactive-subagents@c100577ebf73`.

## Decision

Do not install either reference repository. Reuse only the architectural ideas that fit Workbench's existing trust model.

Build two first-party capabilities:

1. **Session Observations** — optional, branch-local, non-authoritative continuity records used only for compaction and explicit review.
2. **Workbench Agent Runtime** — a persistent RPC-based child-agent manager with an optional cmux viewer/control surface, replacing the external `pi-subagents` package and eventually `pi-background-tasks`.

Keep `workbench_memory` as the only authoritative durable-memory tier. Observations must never promote themselves into shared memory.

## What the reference projects contribute

### `pi-observational-memory`

Useful ideas:

- Fixed transcript chunks with explicit coverage markers.
- Parallel observers whose results may complete out of order.
- Branch-local observation entries so `/tree` does not leak another branch's state.
- A deterministic compaction projection rather than another model call at compaction time.
- Strictly bounded recent observations.

Ideas to reject:

- Model-authored topic and journey files as durable future context.
- Automatic promotion/consolidation into durable memory.
- Treating a clean worker exit as proof that every input observation was handled.
- Passing transcript material in process arguments.
- Inheriting the full parent environment in observer workers.
- A second durable filesystem memory authority beside `workbench_memory`.

Primary references:

- [README](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/README.md)
- [implementation plan](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/PLAN.md)
- [observer scheduling](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/src/hooks/observer-trigger.ts)
- [compaction hook](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/src/hooks/compaction-hook.ts)
- [consolidator](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/src/hooks/consolidator-trigger.ts)
- [worker launcher](https://raw.githubusercontent.com/amosblomqvist/pi-observational-memory/78a1efcfdd46332253fb289724f05b26dfc7769e/src/spawn/launch.ts)

The repository is small and single-maintainer, has no releases or security policy, and its README defaults differ from `src/config.ts`. Those facts do not prove compromise, but they reinforce the decision not to install it.

### `pi-interactive-subagents`

Useful ideas:

- Persistent names and exact child loadout snapshots.
- Start, steer, resume, cancel, and status operations.
- A child can enter a waiting-for-parent state and continue after an answer.
- Versioned activity records and visible child lifecycle states.
- Terminal multiplexer operations isolated behind a small adapter.

Ideas to reject:

- Terminal panes as the process-control or IPC authority.
- Typing generated shell commands into panes.
- Screen scraping, readiness sleeps, and textual completion sentinels.
- Regex-based `safe_bash` as a security boundary.
- Copying or fabricating Pi session JSONL.
- Sidecar files without a strong parent-child capability handshake.

Primary references:

- [README](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/README.md)
- [orchestrator](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/index.ts)
- [tmux adapter](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/tmux.ts)
- [session handling](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/session.ts)
- [activity records](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/activity.ts)
- [child completion and questions](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/subagent-done.ts)
- [unsafe-shell limitations](https://raw.githubusercontent.com/amosblomqvist/pi-interactive-subagents/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/tools/safe-bash.ts)

The fork is now tmux-only. Its README credits a multi-multiplexer upstream. The upstream cmux adapter is useful only as a command vocabulary reference: [cmux adapter](https://raw.githubusercontent.com/HazAT/pi-interactive-subagents/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts). No source should be copied.

## Current Workbench baseline

Workbench already owns most of the safer architecture:

- `subagents.ts` launches Pi in RPC mode with `shell: false`, process-group cancellation, JSONL event handling, read-only budgets, first-party child tools, and dashboard updates.
- `workflow.ts` provides bounded planning, execution, independent review, verification gates, and one-writer orchestration.
- `exclusive-lease.ts` provides token-bound writer leases with PID/start-time checks and symlink-safe lock placement.
- `workflow-state.ts` provides validated, atomic workflow state and run artifacts.
- `dashboard-state.ts` and `dashboard-controller.ts` provide agent groups, jobs, controls, transcripts, tools, and focus behavior.
- `cmux-workbench.ts` already emits only versioned categorical metadata and does not forward prompts, tasks, outputs, summaries, raw errors, labels, or tool names.
- `memory.ts`, `memory-store.ts`, and `memory-access.ts` already implement isolated agent namespaces, reviewed shared proposals, checksums, expiry, supersession, tombstones, atomic writes, locking, import review, and guarded child access.

Important gaps:

1. `subagents.ts` currently launches children with `--no-session`, so children cannot persist or resume.
2. Child launch inherits `...process.env`; this is broader than required.
3. Run state and dashboard state are in memory and cannot recover after parent restart.
4. RPC events are not wrapped in a Workbench run-id/sequence protocol.
5. Child questions are not a first-class runtime state.
6. cmux shows aggregate categorical status but has no per-child interactive surface.
7. `model-routing.ts` still injects guidance and defaults into the external `subagent` tool.
8. `cmux-workbench.ts` still listens to external `subagent:*` and `pi-intercom:*` events.
9. `workbench_memory` intentionally has no automatic transcript capture, leaving room for a separate session-only continuity tier.

Pi's current public API supports the clean design:

- RPC mode provides strict JSONL framing, `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_entries`, `get_tree`, `get_last_assistant_text`, `agent_settled`, and extension UI request/response.
- `SessionManager` and `AgentSessionRuntime` provide supported persistent-session and fork/clone APIs; direct JSONL fabrication is unnecessary.
- `session_before_compact` can return a custom compaction while retaining Pi's prepared cut point and fallback behavior.
- Custom entries created with `pi.appendEntry()` are branch-local and excluded from model context.

Local documentation:

- Pi extensions: `docs/extensions.md`
- RPC protocol: `docs/rpc.md`
- SDK/runtime: `docs/sdk.md`
- session format: `docs/session-format.md`
- compaction: `docs/compaction.md`

## First-party Session Observations

### Trust model

```text
active session branch
  -> policy-filtered source ranges
  -> bounded observer call with no tools
  -> untrusted branch-local observation entry
  -> deterministic compaction projection
  -> optional Coordinator-reviewed memory proposal
  -> workbench_memory
```

Observations are continuity hints, never instructions or durable truth.

### Record format

Use a versioned custom entry such as `pi-workbench-session-observations-v1` containing:

- observation batch ID;
- session ID and current branch anchor;
- exact covered source entry IDs or non-overlapping intervals;
- source digest and parent-computed token estimate;
- explicit exclusions and coverage gaps;
- bounded observations with category, text, confidence, and source entry references;
- route, usage, timestamp, schema version, and parent-computed checksum.

A later completed range must never hide an earlier missing range.

### Observer execution

Prefer a bounded no-tool model call over a general child agent. If a subprocess is retained for isolation:

- send transcript bytes through RPC stdin, never argv;
- use `--no-session`, `--no-extensions`, `--no-prompt-templates`, and no built-in tools;
- pass only a minimal environment;
- exclude system/developer instructions and raw credentials;
- redact likely secrets before provider submission;
- cap input, output, stderr, elapsed time, concurrency, and cost;
- route routine extraction to Luna/low, ambiguous synthesis to Terra/medium, and never use Sol merely for volume;
- discard a late result if the active branch no longer contains its exact anchor and covered IDs.

### Compaction

At `session_before_compact`:

1. Fold only valid observation entries reachable from the current leaf.
2. Verify checksums, branch anchor, source digest, and exact coverage.
3. Select a completed observation boundary near Pi's prepared cut point.
4. Render only fully covered material before that boundary.
5. Keep Pi's recent verbatim tail.
6. Wait only for observers that could affect the cutoff, under a strict deadline.
7. Return `undefined` on gaps, timeout, malformed output, or uncertainty so normal Pi compaction runs.

Do not write topic files, journey files, or an automatic long-term index.

### Promotion

Expose an explicit Coordinator action that converts selected observation IDs into a normal pending `workbench_memory` proposal with `derivedFrom` lineage. Promotion remains the existing Coordinator review flow. Observations remain immutable audit material until normal session retention removes them.

### Rollout

1. Shadow mode: create and inspect observations, but do not affect compaction.
2. Measure unsupported claims, gaps, duplication, secret filtering, latency, and cost.
3. Enable deterministic projection for manual compaction only.
4. Add threshold compaction after branch/failure tests pass.
5. Add explicit memory proposals last.

## First-party Workbench Agent Runtime

### Authority

One `AgentRunManager` owns child process creation, RPC stdin/stdout, process groups, lifecycle, persistence, result validation, and group aggregation. cmux is a client/view, never the run authority.

### Lifecycle

```text
queued -> starting -> running
running <-> paused
running <-> waiting_for_parent
running -> completed | failed | cancelled | interrupted | orphaned
```

Each accepted event must contain a schema version, run ID, monotonically increasing sequence, event kind, and bounded payload. Reject wrong-run, replayed, reordered, malformed, unknown-field, and oversized events.

### Persistent run record

Store private atomic records outside the project tree under the Workbench agent directory:

- run, group, parent, and functional agent IDs;
- canonical cwd and optional worktree;
- Pi session file/ID from supported APIs;
- exact provider/model/thinking route;
- exact tool and extension allowlists;
- profile, task, and prompt digests rather than raw task text where possible;
- budgets, mutation policy, network policy, and child-spawn policy;
- last accepted event sequence;
- PID, process start identity, and terminal state;
- loadout checksum and trusted-extension digests.

Resume fails closed if the record is missing, altered, incompatible, widens privileges, references changed trusted code, or cannot resolve through supported Pi APIs.

### Profiles

Profiles should be typed first-party data, not arbitrary project frontmatter. A project may request a known profile but cannot redefine authority.

Security fields:

- functional role;
- model/thinking class;
- exact tools/extensions;
- canonical cwd policy;
- read/write/network policy;
- child-spawn policy;
- session mode;
- budgets and result contract.

Mutation-capable runs require an isolated worktree or explicit current-tree approval, an owner-token writer lease, a task packet, and a verification gate. Parallel agents remain read-only by default.

### Child launch hardening

Replace broad environment inheritance with an allowlist:

- `PATH`, minimal locale, `HOME`, `TMPDIR`, `SHELL` only when required;
- `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, and fixed Pi markers;
- only the provider credential mechanism required by the selected route;
- no cmux variables unless the child itself is a cmux client;
- no unrelated cloud, GitHub, package-registry, or deployment credentials.

Default agents should not receive Bash. A Bash-capable profile remains cooperative rather than sandboxed until Workbench has a real command broker or OS isolation. Regex command blocking is explicitly not a sandbox.

### Parent-child interaction

Use Pi's RPC protocol, not sidecars or screen scraping:

- `prompt`, `steer`, `follow_up`, and `abort` control the child;
- `agent_settled` is the completion boundary;
- `get_last_assistant_text` obtains the authoritative final answer;
- extension UI requests implement child questions.

A first-party child `ask_parent` tool can call an RPC-compatible UI method. The manager changes the run to `waiting_for_parent`; the Coordinator answers through the matching `extension_ui_response`. No polling is required.

### Public tool surface

Prefer one tool namespace:

- `workbench_agent_start`
- `workbench_agent_message`
- `workbench_agent_status`
- `workbench_agent_answer`
- `workbench_agent_cancel`
- `workbench_agent_focus`

A compatibility `subagent` facade may exist temporarily but must call the same manager and emit deprecation diagnostics. Remove it after migrated sessions and prompts no longer reference it.

### Aggregate completion

Individual child completion updates the dashboard without starting a parent turn. A group emits exactly one continuation after all mandatory children terminate. Actionable blockers/questions may notify once per deduplicated episode. This preserves the existing low-noise notification preference.

## cmux-native interaction

The installed cmux CLI supports the required primitives:

- `new-split <direction> --surface ... --focus false`
- `new-surface --type terminal --pane ... --working-directory ... --focus false`
- `send --surface ...`
- `read-screen --surface ...`
- `focus-pane` / `focus-panel`
- `close-surface`
- `rename-tab`
- `identify`
- workspace status, progress, logs, and notifications.

Do not launch the child agent by typing a generated shell command into cmux. Instead:

1. The authoritative manager starts and owns the RPC child.
2. Workbench optionally creates a cmux terminal surface with focus disabled.
3. The surface runs a small first-party `workbench-agent-view` client identified only by a run ID and private capability reference.
4. The viewer connects to the manager over a local authenticated channel, renders bounded transcript/activity, and forwards explicit user controls.
5. Closing the surface detaches the view; the child keeps running.
6. Missing cmux degrades to the existing dashboard without affecting execution.

No prompt, output, credential, tool name, raw error, or task text belongs in cmux command arguments, titles, status pills, logs, or notifications. Use the approved title grammar `<project or work name> · <lifecycle state>`, for example `Background work · done` or `Researcher 2 · waiting`.

Keep existing dashboard focus behavior (`Ctrl+Alt+Down` / `Ctrl+Alt+Up`). `workbench_agent_focus` may create or focus the optional cmux viewer without making cmux mandatory.

## Replacing `pi-subagents`

The external package is not imported directly by Workbench. Current coupling is narrow:

- `model-routing.ts` injects `pi-subagents` guidance and mutates external `subagent` tool calls.
- `cmux-workbench.ts` listens for `subagent:*` and `pi-intercom:*` events.
- user prompts/skills may reference `subagent`, `runs.run`, and `workflowScript`.

Migration:

1. Land `AgentRunManager` behind Workbench's existing `delegate_task` path.
2. Add persistent start/message/status/answer/cancel operations.
3. Change model routing to target only the first-party manager.
4. Change cmux events to first-party versioned runtime events.
5. Provide a temporary read-only compatibility facade and diagnostics.
6. Migrate prompts, agents, skills, and tests.
7. Remove `npm:pi-subagents` from Pi settings.
8. Remove compatibility listeners and guidance after a soak period.

No mutation workflow should be shadow-run during migration.

## Wider third-party reduction

The active Pi settings currently load nine npm packages plus one git package. The npm lock contains 154 package records. `context-mode` and `better-sqlite3` are marked as install-script packages; `context-mode` itself declares a postinstall script. Integrity hashes improve reproducibility but do not make package scripts trustworthy. Current direct dependency ranges use `^`, so they are not immutably pinned in settings.

Risk-ordered replacement plan:

### Phase A — immediate hardening

- Replace package ranges with exact versions while migration is underway.
- Disable automatic package movement and prefer offline startup.
- Record reviewed source commit, tarball hash, lockfile hash, loaded resources, and reason for every temporary exception.
- Disable unused extension resources even if a package's skills remain temporarily needed.
- Treat project-local skills and prompts as code requiring project trust.

### Phase B — execution-control packages

Replace first because they launch processes, manage sessions, or expose broad tools:

1. `pi-subagents` -> Workbench Agent Runtime.
2. `pi-background-tasks` -> the same runtime's background command and agent job manager.
3. `@capyup/pi-goal` -> a small first-party goal state machine using custom session entries.
4. `@juicesharp/rpiv-ask-user-question` and `@juicesharp/rpiv-todo` -> first-party UI/state tools using `ctx.ui` and custom entries.

### Phase C — provider and specialist packages

- `pi-lmstudio` -> first-party `registerProvider` adapter or Pi native model configuration.
- Minimax MCP package -> first-party web/image provider adapters with explicit network policy.
- `@vigolium/piolium` -> retain only actively used methodologies as reviewed first-party skills; remove its executable extension first.
- `diagram-design` git package -> replace with a reviewed first-party diagram skill and renderer, then remove the moving git checkout.
- `reprompter` submodule -> replace the narrow behavior Workbench actually uses, then remove the submodule and its npm tree.

### Phase D — `context-mode`

Remove last because it currently provides high-value context containment. Replace it with a first-party, dependency-light subsystem:

- bounded command/file capture to private artifacts;
- processing in a constrained child process;
- a small indexed store using Node's built-in SQLite/FTS support where available;
- explicit capture, index, search, stats, and purge contracts;
- no install scripts or native npm addon;
- Session Observations for continuity rather than automatic transcript authority.

Do not remove `context-mode` until large-output tests prove the replacement prevents raw-output context floods.

### Phase E — skill inventory

The global skill directories contain many copied or symlinked third-party skills. Rank them by use frequency and authority:

1. executable extensions and install hooks;
2. skills that instruct shell/network/security actions;
3. provider-specific skills;
4. read-only design/reference skills.

Rewrite only capabilities that are actually used. Delete the rest rather than maintaining unused forks.

## Verification gates

### Session Observations

- out-of-order chunks, duplicate ranges, and explicit gaps;
- branch navigation and late-result discard;
- observer timeout, crash, malformed output, and secret filtering;
- exact compaction cutoff inclusion;
- normal Pi compaction fallback;
- no automatic durable-memory promotion.

### Agent Runtime

- start, steer, follow-up, pause, answer, cancel, timeout, crash, restart, and orphan recovery;
- strict LF-delimited JSONL parsing;
- wrong run ID, replay, reorder, unknown field, and oversized-frame rejection;
- exact route/tool/profile snapshots and privilege-narrowing resume;
- minimal environment and credential-isolation tests;
- process-group TERM, actual-exit detection, and KILL escalation;
- writer lease and worktree enforcement;
- exactly one aggregate completion notification;
- deduplicated blocker notifications.

### cmux

- create/focus/detach/close against the locally installed cmux CLI;
- no focus theft;
- missing cmux falls back to dashboard-only;
- closing a viewer does not stop the agent;
- no secret or task-content sentinel appears in cmux arguments, metadata, logs, or notifications.

### Supply-chain removal

- no removed package remains in settings, lockfiles, extension discovery, skills, prompts, tests, docs, or event listeners;
- startup with `PI_OFFLINE=1` succeeds;
- release checks enumerate only Pi core, Node, and reviewed first-party Workbench resources;
- a clean machine can reproduce the setup without third-party install scripts.

## Recommended implementation order

1. Harden the existing child launcher environment and event framing.
2. Extract `subagents.ts` into the persistent `AgentRunManager` without changing `delegate_task` behavior.
3. Add persistent sessions, child questions, and group aggregation.
4. Add the optional cmux viewer.
5. Cut over and remove `pi-subagents`.
6. Add Session Observations in shadow mode.
7. Enable deterministic observation-backed compaction after evidence is collected.
8. Work through the broader package-removal phases, leaving `context-mode` until its replacement is proven.
