# #148 OneDrive 域名规则集验证归档

通过 PR #152 交付。北京时间 2026-11-20 在干净的 `11e3e09011b2fe966031affeb3382b515ab3cc21` 上执行 `scripts/verify.mjs --release`。该提交与 squash 合并提交 `80f97093380f0b14afee7a6b2483dc23d9630601` 的 Git tree 一致。[工单 #148](https://github.com/wangyingang/sing-box-config-manager/issues/148) · [PR #152](https://github.com/wangyingang/sing-box-config-manager/pull/152)

| 证据 | 验证范围 |
| --- | --- |
| [运行摘要](run/summary.json) | 源码身份、工具、命令和测试统计 |
| [常规检查](run/check.log) | 442 项测试、类型检查、构建和 workspace smoke |
| [原生集成](run/integration.log) | 305 项 sing-box 1.14.4 测试，包含 OneDrive 匹配、隔离 `sync`、候选与稳定入口回读 |
| [固定 Release](run/release.log) | 3 项 V2Fly Release 验收 |
| [固定 Git 构建](onedrive-fixed-build.json) | 固定来源及输入摘要、构建工具身份、JSON/SRS 摘要、18 次原生匹配断言和两种格式的规则集合核对 |
| [构建验收脚本](verify-fixed-build.mjs) | 复现固定上游构建及原生匹配 |
| [文件清单](run/files.json)、[完整性报告](inspection.json) | 运行证据的字节数、SHA-256 和归档前校验结果 |
| [PR 证据](pr-evidence.json)、[生产状态](production-state.json) | PR 的 CI 与云端审查，以及合并后生产门禁和产物分支的核对结果 |

固定输入生成 13 条后缀和 3 条关键词，过滤 `OneDrive` 与 `OneDriveUpdater` 进程条件。两种格式均命中 `cdn.sharepoint.com` 和仅靠关键词命中的 `xskydrivey.example`，均排除 `notsharepoint.com` 和 `xsky-drivey.example`。Route 和 DNS query 共用 `stable/onedrive` 的域名产物，DNS response 为 `unavailable: empty`。[固定上游输入](https://github.com/blackmatrix7/ios_rule_script/blob/0b6897dc17e0c513d25449c935a9694818e32f0c/rule/Clash/OneDrive/OneDrive.list)

本地测试全部通过，无跳过。PR 的 Detect changes 和 Workspace checks 通过，Native sing-box 按 PR 工作流设定跳过。云端 Codex 覆盖 `11e3e09`，无 findings 或行内讨论。[PR CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44590094353) · [云端审查](https://github.com/wangyingang/sing-box-config-manager/pull/152#issuecomment-7018462483)

合并触发的生产 `sync` 返回 `disabled`。产物仓库的 `main` 与 `candidates` 均保持在 `b3c3f53`，OneDrive 生产产物未发布。父工单 #145 的 16 集联合验收待 #149 接入。[生产工作流](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44591178006)

从仓库根目录运行以下命令复核原始运行证据。输出目录须尚不存在。

```sh
mkdir -p .verification
node scripts/inspect-evidence.mjs --evidence docs/verification/issue-148/run --out .verification/issue-148-archive-check
```
