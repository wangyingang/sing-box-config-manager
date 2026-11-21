# #145 的 16 集生产首次发布

2026-11-21（北京时间），正式配置 `bf46226edcaf724357065ab776f248fc4179e78e` 的 16 个规则集首次交付到生产。Actions 预览的 16 集均为 `planned / first-delivery`。正式 `sync` 以 `success` 完成，16 集均为 `delivered`。 [工单 #145](https://github.com/wangyingang/sing-box-config-manager/issues/145) · [Actions 预览](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44884772047) · [Actions 首次发布](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44884895711)

| 产物仓库分支 | 发布前 | 发布验收时 |
| --- | --- | --- |
| `main`（稳定订阅） | `b3c3f5324a7fd023cff4583fb3b3e522591a0aa9` | [`a162d063250f969e0e6878f9b1ea49bf06500495`](https://github.com/wangyingang/sing-box-rule-artifacts/commit/a162d063250f969e0e6878f9b1ea49bf06500495) |
| `candidates`（候选和状态） | `b3c3f5324a7fd023cff4583fb3b3e522591a0aa9` | [`a5e4a38320a7976c6ed635cb0c9482e8c5924466`](https://github.com/wangyingang/sing-box-rule-artifacts/commit/a5e4a38320a7976c6ed635cb0c9482e8c5924466) |

发布后 `status` 核对 16 集均已交付，每集有一个当前可选候选，无待恢复交付或交付异常。逐集对照稳定记录、Artifact Manifest、原生构建记录和回读证据。独立 HTTPS 核验覆盖 32 个固定候选地址、32 个固定交付地址和 32 个公开稳定订阅地址。各文件长度和 SHA-256 均一致。14 个域名集提供 Route 和 DNS query，两个 IP 集提供 Route 和 DNS response。 [发布后状态](status.json) · [逐集验收](verified-delivery.json)

首次发布期间临时启用 `RULE_UPDATE_ENABLED`，正式同步成功后恢复为未设置。`RULE_CLEANUP_ENABLED` 在整个操作期间保持未设置。归档时再次核对两个门禁均处于默认关闭状态，产物分支仍指向表中的验收提交。 [运行与门禁记录](operation-scope.json)

| 证据 | 内容 |
| --- | --- |
| [预览运行](run-44884772047/) | Actions 执行身份、业务结果和 Summary |
| [正式运行](run-44884895711/) | Actions 执行身份、16 集交付结果、64 个固定地址回读及 Summary |
| [生产状态](status.json) | 实际来源、版本、候选、用途、订阅地址及两个观察 head |
| [逐集验收](verified-delivery.json) | 各集版本、来源、JSON/SRS 地址、字节数和 SHA-256 |
| [文件清单](archive-files.json) | 此目录中其余文件的字节数和 SHA-256 |

归档时从两个 Actions 运行重新取得证据，逐字节核对 6 个原始文件，再将预览、正式结果、发布后状态与独立回读记录按规则集交叉核对。
