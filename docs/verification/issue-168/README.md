# #168 混合规则集隔离交付验收

`sync` 从最小 v4 YAML 读取固定 HTTPS URL 的规则，按 `publishPath` 和 `artifact` 交付同名 JSON 与 SRS。隔离测试使用受控 HTTPS 响应和内存产物目标，GitHub 写入适配器测试核对候选登记和输入快照可以写入同一提交。使用实际 sing-box 1.14.4 核对域名、IPv4、IPv6 的正反样本。两种格式的匹配结果一致。

新候选的构建记录、Manifest v3 和订阅交付元数据直接记录文件事实。分别更改同一候选的 Manifest 与构建记录中的 SRS 摘要后，`sync` 拒绝发布。恢复摘要后沿用同一候选 ID 与版本完成交付。

| 证据 | 源码提交 | 范围与结果 |
| --- | --- | --- |
| `final/` | `4ed2ecd946185f4d9594fa3c3b50c4fcca29bb33` | 干净工作区，`check-native`。446 项常规测试和 331 项原生集成测试全部通过，零失败、零跳过。 |
| `prior/` | `70bc439e5a8e74f1b93f6e6965f57e755f164ad3` | 干净工作区，`check-native`。常规检查通过，原生回归发现两条 v3 错误信息变化。恢复原文后的结果见 `final/`。 |

[证据包](evidence.tar.gz) 的 SHA-256 为 `cce78d1b8640c12d56c1b0f6bfa461696a19a8046cefbf74a73a9bd5b75dc23d`。展开后可用 `scripts/inspect-evidence.mjs` 读取两次验证的源码身份、范围与日志完整性。首轮运行的失败结论独立于文件完整性。

最终 PR head 的常规 CI、Linux 原生回归和云端 Codex 复审均完成。云端复审没有 findings。Squash 合并提交为 `1e18cb4a5753e0f9607f66bd4b05835c080bbfb7`，文件树与受测 PR head 一致。 [PR #175](https://github.com/wangyingang/sing-box-config-manager/pull/175) · [常规 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45155173403) · [Linux 原生回归](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45155192758) · [Codex 复审](https://github.com/wangyingang/sing-box-config-manager/pull/175#issuecomment-7097845485)

实际 GitHub 产物发布与正式配置迁移由各自的交付工单继续跟踪。 [#168](https://github.com/wangyingang/sing-box-config-manager/issues/168) · [#174](https://github.com/wangyingang/sing-box-config-manager/issues/174)
