# Contributing to Sreeram's Pi Workbench

This repository is a personal Pi profile. Participation here is governed by the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Before starting

- Use GitHub Issues for reproducible bugs and focused feature proposals.
- Use [private vulnerability reporting](SECURITY.md) for security issues.
- Discuss broad architectural changes before implementation.
- Keep user-facing agent, command, and workflow names functional and clear.

## Development setup

Requirements:

- macOS, Linux, or WSL
- Git
- Node.js 22.19 or newer
- Bun 1.3.14
- Python 3
- Pi coding agent 0.84.4 for installer and RPC integration checks

Clone recursively and install the pinned development dependencies:

```bash
git clone --recurse-submodules https://github.com/bsreeram08/pi-workbench.git
cd pi-workbench
bun install --frozen-lockfile
```

If the repository was cloned without submodules:

```bash
git submodule update --init --recursive
```

## Required checks

Run before opening a pull request:

```bash
bun run check
PI_CODING_AGENT_DIR="$(mktemp -d)/agent" ./install.sh --strict
```

The installer integration check must use a temporary Pi agent directory, not your everyday configuration. Maintainers must also run `bun run release-check` from a clean committed tree before changing visibility or publishing a release.

Changes to memory, child tools, installation, process execution, or trust boundaries need focused regression tests. Never weaken a fail-closed check solely to make a test pass.

Use [Testing the harness](docs/testing-harness.md) for a real Pi tool check and a scratch-project workflow. Native receipts establish command execution and code identity; reviewers must also assess test adequacy. Follow [Harness evaluation](docs/harness-evaluation.md) before claiming improved model quality. Research provenance and audit regression tests cover mechanical guarantees; the evaluation guide distinguishes implemented behavior from remaining research improvements.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Include observable test evidence.
- Update `README.md` when the product surface changes (commands, first-party tools, install). Keep the README a map; put trust internals in `SECURITY.md` and architecture in `docs/`.
- Preserve the single-writer rule: parallel delegated agents must be read-only.
- Do not commit generated Pi state, sessions, memory, research artifacts, credentials, or local backups.
- Review AI-generated code and documentation as carefully as human-written changes.
- Update the RePrompter gitlink only in an explicit dependency-update change, and preserve its license notice.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
