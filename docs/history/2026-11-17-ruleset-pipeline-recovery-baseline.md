# Rule Set Pipeline 恢复缺陷复现

> **历史记录 · 2026-11-17（北京时间）**。以下是修复前基线 `6fc78fda5434acbae244477be45232a3531753a9` 的观察结果。复现调用了真实的 Pipeline 应用服务和 sing-box 1.14.4。Git 写入、HTTPS 和时钟由隔离测试环境控制。

## R1 定时运行卡在待确认交付

- **注入点**　先完成一次同步，再修改上游内容。新的稳定文件提交成功后，通过 `repository.download` 让随后的 HTTPS 回读失败一次。此次同步返回 `pending`，并保留 `journal.pendingDelivery`。
- **修复前结果**　移除故障后连续运行两次 `schedule`，两次都只执行 `status`，退出码均为 1，写入次数均为 0，待确认交付仍在。直接调用 `syncRules` 可以清除登记并确认原交付。

## R2-A 已保存的 building 候选被遗漏

- **注入点**　原候选的 `building` 状态已持久化。通过 `beforeWrite` 让下一次将该候选写为 `publishing` 的 `pipeline/state.json` 提交失败。在隔离单分支和 `main/candidates` 双分支布局中均复现。
- **修复前结果**　移除故障后，第一次重跑同步成功交付了新候选，原候选仍停在 `building`。再次同步返回 `unchanged`，`status` 返回成功。测试时钟推进一年后，`cleanup` 仍被未完成的原候选阻塞。

## R2-B 同源的第二个 publishing 候选被遗漏

- **注入点**　在 `main/candidates` 双分支测试布局中同时修改同源的 `openai` 和 `anthropic` 两个列表。让包含候选 `manifest.json` 的元数据提交失败，直到两集各留下一条 `publishing` 记录，再移除故障。
- **修复前结果**　重跑同步时，第一集恢复原候选，第二集新建候选并交付，留下原 `publishing` 记录。再次同步时两集均为 `unchanged`，`status` 返回成功，`cleanup` 仍被第二集的未完成候选阻塞。

修复已随 PR #91 合入 `003cc39a8bf5ae780e40edf81f56ff73fd260bc9`。[正式工单 #90](https://github.com/wangyingang/sing-box-config-manager/issues/90) · [修复后验收](../verification/issue-90.md)
