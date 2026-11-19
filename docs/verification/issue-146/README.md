# #146 V2Fly 域名规则集验证归档

[工单 #146](https://github.com/wangyingang/sing-box-config-manager/issues/146) 通过 [PR #150](https://github.com/wangyingang/sing-box-config-manager/pull/150) 完成。北京时间 2026-11-20 对干净的 `c23aa486899f0ec88bc8d7d763574aee859ea9f7` 工作区执行了 `scripts/verify.mjs --release`。该提交与 squash 合并提交 `e5a60b5309be3dc73715933763999fb1f56bb89e` 的 Git tree 一致。

| 证据 | 验证范围 |
| --- | --- |
| [运行摘要](run/summary.json) | 源码身份、工具和命令 |
| [常规检查](run/check.log) | 439 项测试、类型检查、构建与 workspace smoke |
| [原生集成](run/integration.log) | 301 项集成测试，使用 sing-box 1.14.4 |
| [固定 Release](run/release.log) | 3 项验收，含八集的上游身份、构建 ID、JSON/SRS 摘要和原生验证结果 |
| [域名场景](run/client-domain-operations.json)、[CIDR 场景](run/client-cidr-operations.json)、[缓存及失败恢复](run/client-failure-cache.json) | 隔离客户端的运行时证据 |
| [文件清单](run/files.json)、[原完整性检查报告](inspection.json) | 原始大小、SHA-256 和收尾前的核验结果 |

所有测试通过，无跳过。八个新增规则集使用固定 V2Fly Release `20261118141523`，生产产物未发布。逐集结果与 GitHub CI、云端审查状态见 [PR 正文](https://github.com/wangyingang/sing-box-config-manager/pull/150)和[收尾记录](https://github.com/wangyingang/sing-box-config-manager/pull/150#issuecomment-7017324395)。父工单 #145 的 16 集联合验收属于后续范围。

从仓库根目录运行以下命令可复核原始文件归档。输出目录须尚不存在。

```sh
mkdir -p .verification
node scripts/inspect-evidence.mjs --evidence docs/verification/issue-146/run --out .verification/issue-146-archive-check
```
