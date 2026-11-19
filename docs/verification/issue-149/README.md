# #149 Sukka 海外流媒体规则与 16 集联合验收

[PR #153](https://github.com/wangyingang/sing-box-config-manager/pull/153) 以 squash 合入 `main`，合并提交为 `8875d9c1c34a9674e812f8e757f9051a5031f9b9`。[工单 #149](https://github.com/wangyingang/sing-box-config-manager/issues/149) 已以 Completed 关闭。验收覆盖干净的 PR head `49da1f48efbb7375342fc52a05b76173e215691b`，其 Git tree 与合并提交一致。

| 证据 | 范围 |
| --- | --- |
| [运行摘要](run/summary.json)、[文件清单](run/files.json)、[完整性检查](inspection.json) | 源码和工具身份、测试统计、日志和内容摘要 |
| [常规检查](run/check.log) | 443 项测试、类型检查、构建与 workspace smoke |
| [原生集成](run/integration.log) | 307 项 sing-box 1.14.4 测试，含匹配、去重、隔离 sync 以及候选和稳定入口回读 |
| [固定 Release](run/release.log) | 3 项固定 V2Fly Release 验收 |
| [16 集构建记录](fixed-builds.json)、[验收脚本](verify-fixed-builds.mjs) | 同一正式配置的 16 集来源、用途、构建与产物身份，以及 18 次原生匹配断言 |
| [PR 证据](pr-evidence.json)、[生产状态](production-state.json) | 工单关闭、PR CI、云端审查及生产产物分支的核对结果 |

固定 Sukka 提交 `838801f009734aa324e7d42d7b7b51561d1df5ba` 生成 60 条精确域名、200 条后缀和 14 条关键词。原始 v2、生成的 v4 JSON 和 SRS 均命中 `tubi.tv`、`sub.viu.tv` 和 `xnetflixdnstesty.invalid`，各域名分别只满足一个字段。三种格式均排除 `unrelated.invalid`、`sub.tubi.tv` 和 `notviu.tv`。Route 和 DNS query 共用 `stable/stream` 的域名产物，DNS response 为 `unavailable: empty`。[固定上游文件](https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/non_ip/stream.json)

联合构建覆盖 11 个 V2Fly 列表、四个固定 Git 来源和受控的 ChatGPT Voice 双栈输入。全部 16 集的 JSON 和 SRS 均经原生验证，用途和稳定路径逐集核对。归档记录固定输入和产物的 SHA-256、大小及复现脚本。

本地测试全部通过，无跳过。PR 的 Detect changes 和 Workspace checks 通过，Native sing-box 按 PR 工作流跳过。云端 Codex 覆盖 `49da1f4`，无 findings 或行内讨论。[PR CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44593963743) · [云端审查](https://github.com/wangyingang/sing-box-config-manager/pull/153#issuecomment-7019119789)

合并触发的生产 `sync` 返回 `disabled`。产物仓库的 `main` 和 `candidates` 均保持在 `b3c3f53`，生产 `stream` 尚未发布。[生产工作流](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44595807023)

从仓库根目录复核运行证据。输出目录须尚不存在。

```sh
mkdir -p .verification
node scripts/inspect-evidence.mjs --evidence docs/verification/issue-149/run --out .verification/issue-149-archive-check
```
