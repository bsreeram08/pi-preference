# Support

## Questions and bugs

Start with [Workflow troubleshooting](docs/troubleshooting.md) for update-marker locks, interrupted planning, optional skill omissions, project trust, and child model routing. [Child instructions and skills](docs/child-context.md) documents source precedence and file limits.

Search existing [GitHub Issues](https://github.com/bsreeram08/pi-workbench/issues) before opening a new one. Use the provided issue forms and include:

- Workbench and Pi versions
- operating system and installation mode
- concise reproduction steps
- expected and actual behavior
- relevant logs with credentials, prompts, paths, and private project data redacted

For workflow failures, include the workflow mode, failing phase, criterion IDs, command exit status, and a redacted summary of `checks-N.md`. Native receipt logs can contain private output; do not upload them without review. [Testing the harness](docs/testing-harness.md) provides isolated reproduction steps and expected outcomes.

For failures before child launch, include the exact latest error, the loaded Workbench checkout's Git revision, and whether Pi was reloaded or restarted after the update. For skill errors, include the file kind and byte size; full skill contents and private instruction files are usually unnecessary. For lock errors, report whether the owner was confirmed live, stale, or ambiguous without publishing raw recovery artifacts.

This is a personal pre-1.0 Pi profile; support and response times are best-effort.

## Security

Do not use a public issue for vulnerabilities. Follow [`SECURITY.md`](SECURITY.md).

## Pi itself

For Pi CLI, provider, or core-extension behavior unrelated to Workbench, use the support channels documented by the Pi project: <https://github.com/earendil-works/pi>.
