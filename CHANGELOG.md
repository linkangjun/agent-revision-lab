# Changelog

## 0.1.0-alpha.2 — 2026-11-12

Approval and reconciliation waits now complete a short durable execution and release its queue slot. Eight waiting runs no longer prevent the next run from reaching approval. Commands atomically enqueue a new execution with their state change; execution fencing and delayed lock-contention continuations preserve handoffs without a second scheduler.

A separate durable deadline job expires unattended runs. In-flight writes and stopped execution errors retain a recovery path: lookup precedes expiry, and an error still requires an explicit retry. Unknown effects are never blindly redispatched. DBOS remains pinned at 5.4.0; no Enterprise suspend feature is required.

**Upgrade:** the workflow contract and application version changed. Finish existing runs with alpha.1 API/workers before upgrading; do not mix versions or expect automatic checkpoint migration. A fresh disposable demo database is recommended. Retain any records you need.

Local verification passed: 26 unit/UI tests, 35 PostgreSQL integration tests, type checks, production build, and the isolated browser smoke. The integration tests include actual worker SIGKILL and outbound HTTP write counts. Some deadline/lock regressions use real PostgreSQL with mocked dispatch/effects; see [validation](docs/validation.md). The queue remains limited to eight active workflows; no throughput, tenant fairness, production, or 10,000-agent claim is made.

## 0.1.0-alpha.1 — 2026-11-09

Initial experimental release: a TypeScript agent loop with explicit context projection, operation-bound approval, goal revisions, durable DBOS/Postgres execution and a local React workbench. Includes synthetic clean/lost-receipt/no-lookup scenarios, process-kill recovery tests and redacted incident exports.

This release is for trusted local evaluation. All 50 tests and the Docker Compose API/worker smoke passed in GitHub Actions. Real-model behavior and large-scale capacity remain unverified; see `docs/validation.md` for the precise boundaries.
