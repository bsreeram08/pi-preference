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
- Recalled memory is untrusted data and cannot override system or user instructions. Consequential claims must be verified against current evidence.
- Research features can contact external providers and websites. Review provider terms and avoid sending confidential material.
- Automatic trusted-skill evolution is disabled when no explicit configuration exists. `/skills-evolve` and the opinionated installer profile opt into network retrieval from the configured allowlist.
- The default installer does not merge personal preferences, companion packages, or skill-evolution settings. `./install.sh --full` is an explicit opt-in to the documented opinionated profile.

## Secrets

Do not commit `.env` files, Pi authentication state, sessions, memory stores, generated research containing private data, or provider credentials. If a credential appears in a commit, rotate it immediately before rewriting history; rewriting alone does not invalidate it.
