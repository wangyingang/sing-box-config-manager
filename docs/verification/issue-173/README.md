# #173 原生组合规则隔离交付验收

`sync` 从 Source Format v4 读取匹配条件，保留顶层规则边界、默认规则字段分组及嵌套 `and`、`or`、`invert`。遇到无法保真转换的子条件时，按顶层规则跳过并报告原因。测试核对跳过后剩余规则的匹配范围，以及原生 SRS 的 100 层逻辑深度边界。

专用目标为 `acceptance-issue-173`，路径为 `stable/issue-173/combined.json` 和 `stable/issue-173/combined.srs`。验收以受控 HTTPS 和内存 Git 验证发布，以 sing-box 1.14.4 实际加载并匹配域名、IPv4、IPv6，以及 AND 条件全满足、仅满足一个和全不满足的样本。正式 16 集配置迁移由 [#174](https://github.com/wangyingang/sing-box-config-manager/issues/174) 跟踪。

| 证据 | 覆盖提交 | 范围与结果 |
| --- | --- | --- |
| `issue-173/6d32ffe/` | `6d32ffeefd895d024f470e78309acaf1f4ce52f1` | 基于包含 #169、#171、#172 的 `main` `9c02d79`。干净工作区，`check-native`。446 项常规测试和 360 项原生集成测试通过，零失败、零跳过。 |
| `issue-173/0d05abf/` | `0d05abf4ac7a9abb4a565a55ec9f1d04878aa422` | 合入 #171 后的本地验收。446 项常规测试和 344 项原生集成测试通过。 |
| `issue-173/83438c0/`、`issue-173/22fcc04/`、`issue-173/1db7e3a/` | 各目录的 `summary.json` | 实施期间的历史记录。合并验收以 `6d32ffe/` 为准。 |
| `integrity/`、`before-merge.json`、`after-merge.json` | 最终 PR head 和合并提交 | 证据完整性、PR 关联及工单完成状态核验。 |

[证据包](evidence.tar.gz) 的 SHA-256 为 `c48ade871c33ab9b46e0392cb3c4676a3600061737201f7660dae8d21ddf3769`。解包后可用 `scripts/inspect-evidence.mjs` 核对最终验收的源码身份、测试统计和文件摘要。

[PR #179](https://github.com/wangyingang/sing-box-config-manager/pull/179) 以 `933dd8e59af5f3ef8ad63ee39246fa5890983041` squash 合入 `main`。合并提交与最终受验 PR head 的文件树一致。[#173](https://github.com/wangyingang/sing-box-config-manager/issues/173) 已按 completed 关闭。

常规 CI 覆盖最终 PR head 并通过。单独触发的 Linux 原生回归覆盖 `0d05abf` 并通过。两轮云端 Codex 审查均无发现，复审覆盖 `1db7e3a`，其后的两次合并调整通过本地全量验证与常规 CI。 [常规 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45162226828) · [Linux 原生回归](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45161098531) · [云端复审](https://github.com/wangyingang/sing-box-config-manager/pull/179#issuecomment-7098787736)
