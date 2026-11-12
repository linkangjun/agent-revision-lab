# Agent Revision Lab 中文指南

[完整中文 README](../README.zh-CN.md) · [English README](../README.md)

[Agent Revision Lab](https://github.com/linkangjun/agent-revision-lab) 是一个 MIT 开源实验台，当前版本为 **0.1.0-alpha.2**。它用合成 API 文档演示一个实际问题：Agent 已经发出经批准的写请求，用户这时修改需求，或者 Worker 崩溃了，系统如何处理旧批准和丢失的回执？

默认使用脚本模型，结果可复现，无需模型 API Key。OpenAI 适配器只完成了模拟 HTTP 协议测试，尚未验证真实模型调用。

## 本地运行

准备 Node.js 22.12 或更高版本：

```sh
git clone https://github.com/linkangjun/agent-revision-lab.git
cd agent-revision-lab
npm ci
npm run demo
```

浏览器打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。默认启动临时 Postgres，停止演示会删除本次数据。要在本地保留运行记录，可以使用仓库附带的 Compose 配置：

```sh
docker compose up --build
```

Compose 使用命名卷保存数据库，Web 端口只发布到主机回环地址，数据库端口不发布到主机。数据库在 Compose 网络内使用 trust 认证，仅用于可信本地演示。本地验证使用临时 Postgres；Compose 构建、启动及 API/Worker 冒烟检查已在 [GitHub Actions](https://github.com/linkangjun/agent-revision-lab/actions/runs/42522479080) 通过，未据此宣称生产可用或跨机器自动故障恢复。

## 跑一遍故障场景

1. 选择 **Scripted (no API key)**，创建一个比较 stable API 版本、排除 beta 的任务。Agent 读取合成证据，再生成一项待批准的报告写入。
2. 在审批前点击 **Revise goal**，加入检查分页的要求。时间线会显示目标版本增加、旧提案作废；新版本的报告包含分页证据，需要重新批准。
3. 选择 **Lost receipt** 创建任务并批准写入。演示发布端保存报告后断开响应，Worker 通过查询原操作找回回执，不再次提交。
4. 选择 **No lookup** 重复实验。回执缺失且没有查询契约时，任务进入待对账状态。确认外部结果后，用 **Reconcile outcome** 记录结论和依据；该操作不会再次写入或撤销原操作。

**Export trace** 可以下载诊断记录。导出保留事件、操作 ID 和参数哈希，省略目标、模型上下文、工具正文和人工备注。

## 工程行为

- **循环与终止**：模型请求工具后，结果按调用 ID 回传。输出截断、轮数耗尽或任务到期会停止推进；只返回一段文本不算报告发布成功。
- **权限与恢复**：校验参数和工具权限，批准绑定一次操作的目标版本与参数哈希。写入意图先落盘。回执未知时先查询，不能确认就等待人工；改变需求无法撤回已经发出的请求。
- **上下文**：每次重新放入当前目标，成组保留工具调用与结果，裁剪较旧的只读步骤。保留最近一步和写入记录；必要内容超预算就停止。界面显示的是 token 估算。
- **调度**：DBOS 与 Postgres 保存工作流状态。同一队列可由多个 Worker 处理，最多八条并行工作流；等待审批或对账会结束当前短执行并释放名额。用户命令与新执行在同一数据库事务提交，独立到期任务在无新命令时也会检查业务期限。不同执行器之间没有自动故障探测，尚未做万级容量验证。

运行 `npm run verify` 检查类型、单元测试和构建；运行 `npm run test:integration` 验证真实 Postgres 行为及 Worker 进程被杀死后的恢复。进程恢复测试在报告已写入、运行账本尚未确认时杀掉 Worker，再以相同执行器 ID 启动替代进程，检查旧回执不会推进新目标，也不会触发重复写入。

这是一套面向本机可信单用户的实验环境。技术细节见[架构说明](architecture.md)和 [DBOS 恢复说明](dbos-notes.md)。

## 从 alpha.1 升级

本次执行检查点合同有变化。请先用 alpha.1 完成现有任务，再一起升级 API 与 Worker；不要混用版本，也不提供旧检查点的自动迁移。合成演示推荐使用新的专用数据库，保留需要的旧记录。详见 [DBOS 恢复与升级说明](dbos-notes.md)。
