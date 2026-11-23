# #172 GitHub 分支文件交付验收

专用目标为 `acceptance-issue-172`。一次同步为同一仓库和分支固定一个 commit。规则集可分别选择 Clash、CIDR 和域名后缀文件。Clash 类型筛选、ASN 跳过计数、已有版本保留、首次失败暂缓交付、独立文件继续交付和空规则集均有测试。验收使用隔离的上游 HTTP 与产物 Git fixture，并用 sing-box 1.14.4 核对 JSON/SRS 加载和匹配。正式 16 集配置迁移由 [#174](https://github.com/wangyingang/sing-box-config-manager/issues/174) 跟踪。

固定 URL 的 PR #177 先合入。#172 整合了配置解析、转换和候选复验，再从包含 #177 的 `main` 提交 `a5ee93833f7f17c9c9f130127c37295575ceb26e` 复验 GitHub 分支、DLC、ChatGPT Voice 和共用的交付流程。

| 证据目录 | 源码提交 | 结果 |
| --- | --- | --- |
| `issue-172-447bb37/` | `447bb37afb8d61f0f8e5c6d11017f4cc369ac927` | 最终验收，干净工作区，`check-native`。446 项常规测试和 353 项原生集成测试全部通过，零失败、零跳过。 |
| `issue-172-853d496/` | `853d496257045ec21e81039feb4b12df41332dc6` | #177 合入前的验收，446 项常规测试和 349 项原生集成测试全部通过。 |
| `issue-172-1d7c1d3/` | `1d7c1d3ad1796ae0809a91d2024a99921f018fd3` | 早期运行，常规检查通过，原生阶段因更新基线而停止。 |
| `issue-172-*-inspection/` | 对应受验提交 | 两次完整验收的文件完整性校验。 |
| `issue-172-pr-180-merge/` | `447bb37afb8d61f0f8e5c6d11017f4cc369ac927` | 合并、工单状态、CI、云端审查与本地同步的收尾记录。 |

[证据包](evidence.tar.gz) 的 SHA-256 为 `d707299a3a9029e56b487483de590f8dfa1fb62f540cb682e274199dba1f61ce`。解包后用 `scripts/inspect-evidence.mjs` 核对各次验证的源码身份、结果与文件摘要。

合并提交 `caefb4b83463851446b43b57569abf249b84893b` 的文件树与最终受验 PR head 一致。GitHub 的变更检测和工作区检查通过，PR 触发规则跳过 Linux 原生任务。云端 Codex 复审覆盖最终 PR head，未发现问题或未解决讨论。 [PR #180](https://github.com/wangyingang/sing-box-config-manager/pull/180) · [CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45161280716) · [Codex 复审](https://github.com/wangyingang/sing-box-config-manager/pull/180#issuecomment-7098970036)

[#172](https://github.com/wangyingang/sing-box-config-manager/issues/172) 已按 completed 关闭。
