# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include credentials, private prompts, session logs, or sensitive project data in a report.

Use GitHub's private vulnerability reporting flow:

<https://github.com/bsreeram08/pi-preference/security/advisories/new>

Include the affected Workbench and Pi versions, operating system, impact, minimal reproduction, and any suggested mitigation. Redact all credentials and personal or proprietary data. The maintainer will acknowledge and triage reports as availability permits.

## Supported versions

Security fixes are applied to the latest release on `main`. Pre-1.0 versions may receive breaking security hardening.

## Trust model

Pi packages and extensions execute code with the permissions of the user running Pi. Review this repository and its pinned submodule before installation.

Important boundaries:

- Workbench's child-memory guards provide cooperative tool-level isolation; they are not an operating-system sandbox against arbitrary native code or a malicious same-user process.
- Child agents can run Pi tools and inherit the Pi process environment. Do not launch Pi from an environment containing credentials that agents do not need.
- Mandatory workflow child results fail closed on cancellation, nonzero exit, or blank output. A project-scoped owner-token writer lease serializes write-capable entrypoints, but it is cooperative same-user coordination rather than an OS sandbox; every existing lease classification blocks until an operator verifies and deliberately resolves it.
- cmux receives only fixed categorical lifecycle metadata. The Workbench cmux companion does not forward prompts, tasks, outputs, summaries, raw errors, details, labels, or tool names, and `cmux-session.ts` remains the owner of ordinary parent completion notifications.
- Workflow `current.json` is authoritative and corruption-visible. It is validated and atomically replaced after its plan projection; malformed JSON, unsafe file kinds/paths, unknown shapes, and read failures stop the workflow. Confirmation-gated workflow and council actions revalidate an ephemeral in-memory snapshot before launch or persistence; mismatches leave the newer authority untouched and require the user to rerun and reconfirm. Workbench does not automatically recover, replay, or resume interrupted writer work.
- Recalled memory is untrusted data and cannot override system or user instructions. Consequential claims must be verified against current evidence. Import rejects unknown properties, validates supported versions, checksums, safety filters, bounds, and conflicts before staging, preserves corrupt same-ID local records, and uses a durable visibility barrier during apply; only a Coordinator-approved review can be applied.
- Research features can contact external providers and websites. Review provider terms and avoid sending confidential material.
- Automatic trusted-skill evolution is disabled when no explicit configuration exists. `/skills-evolve` and the opinionated installer profile opt into network retrieval from the configured allowlist.
- The default installer does not merge personal preferences, companion packages, or skill-evolution settings. `./install.sh --full` is an explicit opt-in to the documented opinionated profile. Every successful install transaction records only that explicit `default`/`full` choice for later updater use; legacy values are never guessed.
- `/workbench-update` is manual-only and fail-closed. It requires a real clean recursive clone attached to `main`, one exact trusted HTTPS origin, exact trusted root and RePrompter Git metadata, a valid recorded profile, a successful bounded GitHub Releases response, and linear ancestry. Stable releases permanently supersede the `main` bootstrap channel. Apply holds a fixed owner-token lease, reconfirms and revalidates the candidate, fetches only the fixed chosen ref from the trusted URL, permits only the pinned RePrompter submodule mapping, derives rollback classification from immutable old/candidate commits and the candidate gitlink, privately simulates candidate config output, and verifies a complete same-filesystem checkout snapshot before mutation. Rollback never resets, cleans, force-checks out, or overwrites the checkout: it preserves the whole failed candidate directory and restores the old snapshot through atomic no-replace renames. Deterministic replaced config values are preserved before originals are installed with exclusive no-replace creation; symlink, special-path, and concurrent-value races fail closed without deleting recovery values. Bounded root/RePrompter fingerprints classify ignored credential and runtime-state changes as incomplete rollback; declared rebuildable cache trees are excluded from that classification. Recovery locations remain in the private manifest and never enter audit/UI output; audit records only categorical recovery state. Existing leases are cooperative coordination, not a claim that noncooperating same-user writers can be locked out. Audit appends require a no-follow regular 0600 file, reload occurs only after verified success, existing locks are never taken over, and incomplete rollback never reloads.
- `bun run capabilities:check` is validate-only. It reads only allowlisted capability metadata and compares configured package sources, lock metadata, installed identities, discoverable names, real approved target chains, approved public symlinks, and exclusions. Explicit extension/theme source settings are drift rather than basename-matched aliases. It does not execute packages/extensions, inspect credentials, validate resource syntax/schema, or prove successful loading in an already-running process. Exit status `1` is drift; `2` means inspection failed closed. It has no fix/install/fetch mode.
- `pi-autoresearch` and `@dietrichgebert/ponytail` are hard runtime exclusions in the capability manifest. This does not delete or forbid separately reviewed autoresearch skill documents.

## Secrets

Do not commit `.env` files, Pi authentication state, sessions, memory stores, generated research containing private data, or provider credentials. If a credential appears in a commit, rotate it immediately before rewriting history; rewriting alone does not invalidate it.
