# Changelog

## 0.1.0-alpha.1 — 2026-11-09

Initial experimental release: a TypeScript agent loop with explicit context projection, operation-bound approval, goal revisions, durable DBOS/Postgres execution and a local React workbench. Includes synthetic clean/lost-receipt/no-lookup scenarios, process-kill recovery tests and redacted incident exports.

This release is for trusted local evaluation. All 50 tests and the Docker Compose API/worker smoke passed in GitHub Actions. Real-model behavior and large-scale capacity remain unverified; see `docs/validation.md` for the precise boundaries.
