# PR #184 china-domains 隔离换源验收

PR 将现有 `china-domains` 的规则源从 V2Fly DLC 切换为 `SagerNet/sing-geosite` 的 `rule-set/geosite-geolocation-cn.srs`，格式为 `sing-box-srs`。隔离测试沿用同一个系统规则集 ID 和两个稳定订阅路径。[PR #184](https://github.com/wangyingang/sing-box-config-manager/pull/184)

| 对象 | 身份 |
| --- | --- |
| 真实 GitHub 隔离换源使用的源码提交 | `9a34398b596ca42f4e336ef0b5e264a08179f9bd` |
| 通过最终 CI、云端复审与 24 项定向复验的源码提交 | `961cd5575a267b4f96cce4281b9aa4a9c6fb283f` |
| 合入 main 的 squash 提交 | `b586688a042f209bd6b54160504a0ede89531464` |
| 官方 SRS 的分支提交 | `e15c5cbcfa72c589fada8dd3de60af9996119f95` |
| 隔离分支 | `acceptance-china-domains-c8b49f87-380` |
| 隔离交付提交 | `86016a077b0f6031c8c00242b83758b580c02a56` |

隔离环境依次执行 DLC 基线、SRS 下载返回 HTTP 503、恢复下载后三次 `sync`。失败时两个稳定地址均继续交付旧版。恢复后 `status` 显示当前版本来自 SagerNet。首次轮询可变分支地址时超时，随后针对同一地址的独立 HTTPS 回读通过，两份规则文件的摘要与固定交付提交一致。两种格式的规则结构与原始官方 SRS 一致，6 个原生匹配探针结果一致。DLC 版的 `a1.mzstatic.com` 未匹配，换源后匹配。[固定交付文件](https://github.com/wangyingang/sing-box-rule-artifacts/tree/86016a077b0f6031c8c00242b83758b580c02a56/stable/china-domains)

`pnpm check` 的工作区日志来自隔离验收源码。最终提交复跑通过 24 项定向测试，GitHub Detect changes 和 Workspace checks 通过，Native sing-box 作业按 PR 工作流条件跳过。云端复审覆盖最终提交，无 findings。完整 16 集正式远端验收未重复执行。PR 无关联待关闭工单。[CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/46056304551) · [云端审查](https://github.com/wangyingang/sing-box-config-manager/pull/184#issuecomment-7226248423)

合并触发的生产规则工作流记录为 `disabled`。产物仓库生产 `main` 和 `candidates` 的引用前后一致，生产写入和清理门禁均未启用。[合并触发的工作流](https://github.com/wangyingang/sing-box-config-manager/actions/runs/46057031214)

[下载验收证据](evidence.tar.gz)。归档中的本机路径替换为占位符，SRS 文件按原字节保存。

| 目录或文件 | 用途 |
| --- | --- |
| `first-attempt/` | 格式改名前的隔离运行及首次 HTTPS 轮询超时记录 |
| `isolated-acceptance/` | 最新隔离换源、独立 HTTPS 回读、实际规则字节、脚本和当时的测试与审查记录 |
| `closeout/` | 最终版本的定向验证、合并凭据、合并后工作流与生产引用检查，以及原始证据文件摘要 |
| `SHA256SUMS` | 所有归档文件的逐项校验值 |

在本目录运行以下命令核对归档及其内容。

```sh
echo '7f6babb31022a1339eaa55e5aba5d55076611afe60a3d1c4dc923c85bd8af148  evidence.tar.gz' | shasum -a 256 -c -
evidence_dir=$(mktemp -d)
tar -xzf evidence.tar.gz -C "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c SHA256SUMS)
```
