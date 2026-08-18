# Workbench Memory Model

Workbench memory is a native TypeScript persistence module for durable agent findings. It is separate from Pi sessions, workflow artifacts, research evidence, and explicit user preferences.

## Trust model

1. System, developer, and current user instructions always outrank recalled memory.
2. Recalled entries are claims, not instructions. Consequential project facts must be checked against the current workspace.
3. A checksum establishes only that the loaded file still matches the checksum written with it. It does not prove that the claim is true and is not a signature against an attacker who can rewrite both content and checksum.
4. The Coordinator is the review authority for shared memory. Specialists cannot promote their own proposals.
5. Private agent namespaces are isolated from other specialists. The Coordinator may inspect a named namespace when reviewing or correcting memory.
6. Explicit durable user preferences belong in `preference_memory`, not Workbench memory.

## Storage

All project-scoped memory stays outside child workspaces:

```text
~/.pi/agent/memory/pi-workbench/projects/<canonical-project-hash>/
├── shared/{entries,tombstones}/
├── pending/{entries,tombstones}/
└── agents/<agent-id>/{entries,tombstones}/
```

Reusable cross-project memory uses:

```text
~/.pi/agent/memory/pi-workbench/
├── shared/{entries,tombstones}/
├── pending/{entries,tombstones}/
└── agents/<agent-id>/{entries,tombstones}/
```

Project facts and decisions are rejected in global scope. They remain logically attached to the project whose evidence supports them. The project hash is derived from the filesystem-canonical (`realpath`) project root, so a real path and its symlink share one namespace and lock; entries also retain that canonical `projectRoot` for attribution.

## Entry schema

Every immutable entry records:

| Field | Purpose |
|---|---|
| `id`, `version` | Stable identity and schema version |
| `scope` | `project` or `global` |
| `audience`, `agentId` | Shared visibility or one private agent namespace |
| `kind` | `fact`, `decision`, `learning`, or `warning` |
| `summary`, `evidence` | Bounded claim and verification reference |
| `sourceAgent` | Agent identity supplied through `PI_WORKBENCH_AGENT` |
| `createdAt`, `expiresAt` | Recording time and optional volatility boundary |
| `derivedFrom`, `supersedes` | Lightweight lineage and correction links |
| `pending`, `promotedAt`, `promotedBy` | Shared-review lifecycle |
| `checksum` | SHA-256 over the material entry fields |

Promotion preserves the proposal ID and source agent while recording the Coordinator and promotion time. A superseding entry suppresses the older entry from normal recall without destroying its audit record.

## Authorization matrix

| Action | Coordinator | Specialist child agent |
|---|---:|---:|
| Recall shared memory | Yes | Yes |
| Recall own private memory | Yes | Yes |
| Recall another specialist's private memory | Yes, for review | No |
| Write own private memory | Yes | Yes |
| Write shared memory directly | Yes | No |
| Submit a shared proposal | Yes | Yes |
| Inspect pending proposals | Yes | No |
| Promote a proposal | Yes | No |
| Forget shared/pending memory | Yes | No |
| Forget own private memory | Yes | Yes |

The child extension derives identity from `PI_WORKBENCH_AGENT`; callers cannot select a different private namespace. Worktree-based implementation candidates receive the canonical parent project root through `PI_WORKBENCH_PROJECT_ROOT`, so their memory survives temporary worktree cleanup.

All project/global memory storage is outside the project tree, and unsafe configurations with `PI_CODING_AGENT_DIR` or its canonical memory target inside the project are rejected. The child extension blocks direct `read`, `write`, `edit`, `grep`, `find`, `ls`, and recognizable Bash access—including home/Pi-agent path forms—to protected memory roots. Specialists must use `workbench_memory`, which enforces namespace and review rules. This is a strong tool-level isolation policy for cooperative Workbench agents, not an operating-system sandbox against arbitrary same-user native code.

## Recall and context injection

Automatic context injection is project-default and retrieves only:

- reviewed project-shared entries; and
- private project entries for the current agent.

Global learnings/warnings require an explicit `scope: "global"` recall instead of silently entering every project prompt. Recall uses bounded keyword relevance and recency. It deduplicates IDs, suppresses superseded entries, excludes expired entries by default, and caps automatic context at 12,000 characters. `includeStale` exposes expired entries; `includeSuperseded` exposes correction history for audit.

Each injected block states that memory is fallible data, cannot override instructions, and must be reverified when consequential. Pending proposals are never injected.

Semantic/vector retrieval and automatic entity extraction are deliberately deferred. They are not justified until the deterministic store has enough high-value entries for keyword recall to become measurably inadequate. QMD is the preferred future retrieval adapter because it is already native to Workbench and avoids a second runtime stack.

## Writes and concurrency

Each entry and tombstone is a separate JSON file written through temporary-file replacement. Writes within a scope are serialized by an atomic lock directory whose owner record contains a random token, PID, host, and creation time. Release verifies the owner token before removing the lock. This preserves collection-level deduplication and promotion behavior when multiple child processes finish concurrently.

Lock recovery deliberately fails closed. Workbench never deletes a lock merely because it appears old or its PID appears dead; doing so can race with a replacement owner. After an interrupted process, inspect the recorded owner and verify no writer is active before manually removing the reported `.write-lock` directory. The lock is designed for Workbench agents on one machine and a normal local filesystem, not distributed consensus over a network share.

Promotion writes the shared entry before invalidating the pending proposal. After any abandoned lock is deliberately cleared, repeating promotion is idempotent and repairs an interrupted promotion by completing the pending tombstone.

## Invalidation and integrity

`forget` never erases the entry file. It writes a tombstone containing:

- the entry ID and original entry checksum;
- who invalidated it and when;
- the bounded reason; and
- a tombstone checksum.

A valid tombstone suppresses only the exact entry checksum it references. A malformed, altered, or mismatched tombstone is reported as an integrity failure and cannot silently hide an entry. Altered or unreadable entries are excluded from recall and counted by `/memory` status.

Expiry is different from invalidation: an expired entry remains present and can be recalled explicitly with `includeStale`.

## Safety filters

The store rejects likely:

- API keys, access tokens, passwords, private keys, and JWTs;
- sensitive personal data such as social-security numbers and labeled financial, medical, address, or birth-date fields;
- prompt-injection-shaped attempts to override system/developer instructions;
- global project facts and decisions; and
- invalid agent IDs, memory IDs, timestamps, or excessive lineage links.

Summary and evidence lengths are bounded before persistence. Forget reasons pass through the same safety check.

These filters reduce accidental retention; they are not a substitute for reviewing what an agent proposes to remember.

## What to remember

Good entries materially reduce future rediscovery:

- a verified repository convention with an exact path;
- an approved architectural decision and its decision record;
- a non-obvious failure mode with a regression-test path;
- a reusable implementation learning; or
- a warning about a recurring unsafe approach.

Do not store routine progress, raw conversation transcripts, speculative guesses without labels/evidence, current-prompt restatements, credentials, personal data, or user preferences.

## External concepts adapted

The module borrows concepts, not runtime code, from two inspected projects:

- `tickernelz/pi-memory`: explicit remember/recall/forget affordances and cross-session continuity. Workbench replaces its unrestricted overwrite and unbounded prompt injection with immutable entries, isolation, review, limits, tombstones, and process-safe writes.
- Semantica: namespaced multi-agent context, provenance attribution, derivation/supersession links, expiry/retention, invalidation, and integrity checks. Workbench does not import Semantica because its Python vector/graph stack is disproportionate for a Pi extension.

Deferred Semantica-inspired capabilities include a real provenance hash-chain ledger, graph traversal, confidence-aware conflict resolution, decision-precedent search, and embeddings. They should be added only behind measured retrieval or audit requirements, not preemptively.

## Distribution and recovery

Memory is runtime state and is excluded from the Pi Workbench repository and installer. A fresh machine starts with no agent memory. Copy memory roots separately only when intentionally migrating trusted local state.

If `/memory` reports integrity failures, inspect the affected collection files before restoring from backup or invalidating them. Never repair a checksum merely to silence the report without first establishing why the record changed. If a write reports an abandoned `.write-lock`, verify the recorded PID/host is no longer writing before removing that exact lock directory.
