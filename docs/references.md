# References and attribution

The implementation in this repository was written for this project. The following existing work informed its design; this is not a fork or a claim to have invented durable execution, compaction, human approval, or fault injection.

- [Pi](https://github.com/earendil-works/pi), MIT. Research snapshot [`9879bb4`](https://github.com/earendil-works/pi/tree/9879bb44754ce42f52800371aac8cfbccf521cb7): agent loop, tool/result pairing, compaction, and experimental durable harness. No Pi implementation source was copied into this repository.
- [DBOS Transact TypeScript](https://github.com/dbos-inc/dbos-transact-ts), MIT. This project depends on the published SDK for durable workflows, queueing and transactional notifications. Its license remains with the dependency.
- [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) and [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
- [Temporal Activity idempotency](https://docs.temporal.io/activity-definition#idempotency) and [AI cookbook](https://docs.temporal.io/ai-cookbook).
- [Restate's interrupt/regenerate pattern](https://docs.restate.dev/ai/patterns/interrupt-regenerate), a close reference for changing long-running agent work. Its server has a BSL license; no Restate server code is incorporated here.
- [agentic-chaos](https://github.com/DeepAgentLabs/agentic-chaos) and [agent-durability-bench](https://github.com/sdageltc/agent-durability-bench), examples of prior agent fault-testing work. This project does not reproduce their results or claim an independently verified comparison.

Dependencies carry their own license files in their distributions. MIT attribution in this repository covers this project's code, not authorship of those dependencies.
