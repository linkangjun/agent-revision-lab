# Roadmap

The alpha is a working reference, not a finished production runtime. Future work should be driven by reproducible user needs.

- [x] Goal-revision-bound approval and operation ledger.
- [x] Explicit uncertainty and manual reconciliation.
- [x] Durable worker restart and real process-death regression.
- [x] Local timeline, context inspection and sanitized incident metadata.
- [x] Scripted scenario and optional OpenAI protocol adapter.
- [ ] Independent users reproducing their own tool failures; stable SDK surface.
- [ ] Live-model integration validation with an explicitly budgeted test account.
- [ ] Provider-authoritative token/usage accounting and monetary budgets.
- [ ] Artifact storage and provenance-preserving semantic summaries beyond grouped history trimming.
- [ ] Secure multi-user deployment and authentication before any hosted version.
- [x] Short executions that release queue capacity while waiting, with durable deadline checks.
- [ ] Per-tenant fairness and rate budgets.
- [ ] Automatic failure detection and safe cross-worker takeover, including partitions and rolling upgrades.
- [ ] Published 10,000-active-run measurements, including long waits and hardware/configuration details.
- [ ] Framework integrations selected from actual demand, not an integration-count target.

A Star target is not an engineering guarantee. Adoption, reproducible bug reports and successful independent integrations matter more than a promised number. No performance, production-scale or community-growth result is implied by this roadmap.
