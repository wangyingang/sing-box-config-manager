# 工单 #35 验收记录

2026-11-06。在 `codex/issue-35` 任务 worktree 中使用可信宿主的合成订阅样本验收；样本位于 [`examples/three-rule-subscriptions-v2.json`](../../examples/three-rule-subscriptions-v2.json)。三个 HTTPS URL 是测试入口形状，不表示产物仓库已有这些稳定文件，也不证明远程规则字节。测试 binary 为本机 `sing-box 1.14.4`。

## 已执行

| 检查 | 结果 |
| --- | --- |
| `test/issue-35.test.ts` | 五种 Client Profile 各自使用合法本地 DNS 配置编译同一三集 Recipe；三个逻辑 ID 对应各自稳定 SRS URL，Route 与 DNS 请求复用该集 SRS，DNS 响应不可用。JSON Schema 校验三份 v2 声明。 |
| `test/issue-35.test.ts` | 一份 Recipe 发布快照保留三个订阅及 URL，交付配置保持相同绑定；v1、不可用 DNS 响应用途和共享 URL 的冲突声明在编译或发布前失败。直接已解析编译、直接配置发布和完整性有效的交付快照均拒绝 v1；交付也拒绝来源记录不一致及入口声明冲突。 |
| `test/integration/subscriptions.test.ts` | `publishRecipe` 使用真实 `sing-box check` 发布三集配置并读回本地发布文件，`renderSubscription` 交付三个正确 URL；该文件两个测试均通过。 |
| 单元测试 | 工具脚本 21、Compiler 99、Pipeline 91 个测试通过。 |
| 真实 binary 集成测试 | Compiler 28 个测试通过；受本次改动影响的 Pipeline 客户端激活及故障恢复 2 个测试通过。 |
| 类型、构建与工作区消费 | Compiler、Pipeline 的 `tsc --noEmit` 与 build 类型检查通过；Compiler bundle 构建和 `smoke:workspace` 通过。 |

## 未执行

- 未读取或发布 V2Fly 固定 Release 的三个真实列表，也未执行多集 Pipeline v2 激活和远端 URL 回读。这些能力由 #36–#39 交付；本工单使用可信宿主提供的订阅样本验收 Compiler 消费路径。
- 未在五种实际客户端平台运行配置。五种 Profile 的验收到 Compiler 能力检查和 macOS 本机 `sing-box 1.14.4` 原生配置检查为止。
