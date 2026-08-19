# Third-party notices

Sreeram's Pi Workbench is licensed under the MIT License. The following projects are used, referenced, or acknowledged separately.

## RePrompter

- Source: <https://github.com/AytuncYildizli/reprompter>
- Pinned as the `reprompter/` Git submodule
- License: MIT
- Copyright: Aytunc Yildizli

The complete upstream license notice is preserved at [`reprompter/LICENSE`](reprompter/LICENSE).

## Pi coding agent packages

- Source: <https://github.com/earendil-works/pi>
- Packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox`
- License: MIT

These are runtime peer dependencies supplied by Pi and development dependencies used for verification. They are not relicensed by this repository.

## Memory design acknowledgements

The Workbench memory design adapts general concepts—such as isolated namespaces, provenance, bounded recall, integrity records, and tombstones—from public documentation and source inspection of:

- `tickernelz/pi-memory` — MIT: <https://github.com/tickernelz/pi-memory>
- Semantica — MIT: <https://github.com/semantica-agi/semantica>

Neither project is bundled or installed as a Workbench runtime dependency.

## Optional external sources

The opinionated setup profile can enable trusted skill retrieval from repositories named in `setup/defaults/skill-evolution.json`. Retrieved skills remain governed by their own repositories and licenses. Review those sources before opting in.
