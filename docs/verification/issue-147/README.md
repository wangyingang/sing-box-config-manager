# #147 GFW 域名规则集验证归档

通过 PR #151 交付。北京时间 2026-11-20 在干净的 `5987d55cd7d98a64417ff77dbff525c563b40e35` 上执行 `scripts/verify.mjs --release`。该提交与 squash 合并提交 `6577efe90182443c9aacdfe492b2952c40968b3a` 的 Git tree 一致。[工单 #147](https://github.com/wangyingang/sing-box-config-manager/issues/147) · [PR #151](https://github.com/wangyingang/sing-box-config-manager/pull/151)

| 证据 | 验证范围 |
| --- | --- |
| [运行摘要](run/summary.json) | 源码身份、工具、命令和各项统计 |
| [常规检查](run/check.log) | 441 项测试、类型检查、构建及 workspace smoke |
| [原生集成](run/integration.log) | 303 项 sing-box 1.14.4 测试，包含 GFW 匹配、隔离 `sync`、候选与稳定订阅回读，以及失败时保留当前版本 |
| [固定 Release](run/release.log) | 3 项 V2Fly Release 验收 |
| [固定 Git 构建](gfw-fixed-build.json) | 上游 Git 提交、输入 SHA-256、4,453 条匹配项、JSON/SRS 摘要和原生正反匹配 |
| [域名场景](run/client-domain-operations.json)、[CIDR 场景](run/client-cidr-operations.json)、[缓存及失败恢复](run/client-failure-cache.json) | 隔离客户端运行记录 |
| [文件清单](run/files.json)、[完整性报告](inspection.json) | 文件字节数、SHA-256 和归档前的核验结果 |

本地测试全部通过，无跳过。PR 的 Detect changes 和 Workspace checks 通过，Native sing-box 按 PR 工作流设定跳过。云端 Codex 审查覆盖 `5987d55`，无 findings。[PR CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44586695149) · [审查结果](https://github.com/wangyingang/sing-box-config-manager/pull/151#issuecomment-7018010954)

合并阶段的生产发布状态为未发布。固定 Git 输入可按构建记录重新获取，生成文件由该记录中的 SHA-256 核对。父工单 #145 的 16 集联合验收待其余定义接入。[固定上游输入](https://github.com/Loyalsoldier/v2ray-rules-dat/blob/3914c5cf42be87696db5139fc4b7d681b09b8d4a/gfw.txt)

从仓库根目录运行以下命令复核原始运行证据。输出目录须尚不存在。

```sh
mkdir -p .verification
node scripts/inspect-evidence.mjs --evidence docs/verification/issue-147/run --out .verification/issue-147-archive-check
```
