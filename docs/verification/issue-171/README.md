# #171 固定 URL、DLC 命名列表与 ChatGPT Voice 验收

DLC 规则集从固定 HTTPS URL 共用一次获取与 SHA-256 校验，各自选取命名列表并筛选标签。受控测试覆盖四种过滤组合、字面量 `!cn`、去标签、空集和缺失列表、摘要故障隔离，以及成功检查与版本保留。ChatGPT Voice 整文件转换为双栈 CIDR。测试以 sing-box 1.14.4 核对 JSON 和 SRS 的实际匹配。

真实上游探针读取 V2Fly DLC 发布 `20261123085441` 的正文与摘要，以及 OpenAI 官方 Voice JSON。三套规则通过本票独立的内存目标 `acceptance-issue-171` 交付并核对 12 个原生匹配结果。本次验证范围为上游 HTTP、内存交付与本地原生验证。正式 16 集配置迁移由 #174 跟踪。[V2Fly Release](https://github.com/v2fly/domain-list-community/releases/tag/20261123085441) · [Voice JSON](https://openai.com/chatgpt-voice.json)

| 归档内路径 | 验证范围 |
| --- | --- |
| `issue-171/verification-710bb9c/` | 基于含 #169 的 `main` 提交 `01cff57` 进行最终复验。干净的 PR head `710bb9cde30fd9e906044fe03a30b6586b888c54` 通过 446 项常规测试和 337 项原生集成测试。零失败、零跳过。 |
| `issue-171/evidence-report-710bb9c/` | 最终全量证据的完整性校验。 |
| `issue-171/official-upstreams-710bb9c.json`、`issue-171/targeted-710bb9c.log` | 真实上游探针和 #169、#171 的定向回归。目录内还保留探针脚本和早期验收证据。 |
| `merge/report.json` | 合并和工单收尾快照。 |

[证据包](evidence.tar.gz) 的 SHA-256 为 `65dea094b886ed937010d7064f141f74178deae8629bd32eb8b15f293b798af1`。解包后可用 `scripts/inspect-evidence.mjs` 核对两份全量证据及测试统计。

[PR #177](https://github.com/wangyingang/sing-box-config-manager/pull/177) 以 `ba4c8de8ce0034b3eb81ba80562702a3189f2946` squash 合入 `main`。合并提交的文件树与受验 PR head 一致。常规 CI 通过，PR 工作流按配置跳过原生 job。云端 Codex 审查覆盖同一 PR head，无 findings 或待解决讨论。#171 已按 completed 关闭。[CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45159566646) · [云端审查](https://github.com/wangyingang/sing-box-config-manager/pull/177#issuecomment-7098548567) · [工单 #171](https://github.com/wangyingang/sing-box-config-manager/issues/171)
