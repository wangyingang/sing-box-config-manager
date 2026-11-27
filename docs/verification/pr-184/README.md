# PR #184 china-domains 换源与验收

PR 将现有 `china-domains` 的规则源从 V2Fly DLC 切换为 `SagerNet/sing-geosite` 的 `rule-set/geosite-geolocation-cn.srs`，格式为 `sing-box-srs`。隔离测试沿用同一个系统规则集 ID 和两个稳定订阅路径。[PR #184](https://github.com/wangyingang/sing-box-config-manager/pull/184)

## 换源原因

`china-domains` 原先直接选取 V2Fly DLC 的 `geolocation-cn`。这次换源是为了跟随 sing-box 官方对中国区域名的归类，将 DLC 中按类别单独维护的中国区条目也纳入这个规则集。

SagerNet 以 DLC 的 `geolocation-cn` 为基础，将未带属性的 `category-*-cn` 列表和符合条件的 `category-*@cn` 条目合并、去重。`@cn` 组的基础类别名须以 `category-` 开头，且结尾排除 `-cn` 和 `-!cn`。使用官方生成的 `geosite-geolocation-cn.srs`，`china-domains` 随 SagerNet 更新并采用其归类结果。[SagerNet 的合并逻辑](https://github.com/SagerNet/sing-geosite/blob/dd64ae0ebf2ee69166c0510042b3e96c085f27df/main.go#L243-L295)

## 隔离验收与合并

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

PR 合并当时，自动触发的生产规则工作流记录为 `disabled`。该次工作流前后，产物仓库生产 `main` 和 `candidates` 的引用一致，生产写入和清理门禁均未启用。后续单集切换见下节。[合并触发的工作流](https://github.com/wangyingang/sing-box-config-manager/actions/runs/46057031214)

[下载隔离验收证据](evidence.tar.gz)。归档中的本机路径替换为占位符，SRS 文件按原字节保存。

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

## 生产换源与回读

2026-11-28（北京时间）在生产执行单集 `resume china-domains`。原版本为 `2026-11-23T13:40:04.939Z~7e03ac03`，新版本为 `2026-11-27T19:40:16.497Z~3a75a32d`。新版本使用上游提交 `e15c5cb`，生产稳定交付提交为 `7f6cfcc`。[固定交付文件](https://github.com/wangyingang/sing-box-rule-artifacts/tree/7f6cfcc3c39cdc594d33b8b7c75302e221e191de/stable/china-domains)

北京时间 03:42，两种格式从原订阅地址首次 GET 即返回新版。字节数和 SHA-256 均与固定交付提交一致。用 sing-box 1.14.4 加载后，两种格式和原始官方 SRS 的规则结构一致，5 个匹配探针结果一致。

| 原订阅地址 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [domains.json](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/stable/china-domains/domains.json) | 238751 | `e885421c291fa08f4a2591f483958fdb3ca761f8a264ad4071b3e3e8ae5b5cf7` |
| [domains.srs](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/stable/china-domains/domains.srs) | 50582 | `b8ae69e04c7a68a2f53c4f8b8d5847f56364caa9abe227cdf08ccc5cdb9d8415` |

其余 15 个规则集的 30 个订阅文件、15 份交付记录均逐项比对了换源前后的 Git blob ID、文件长度和模式。45 项全部一致，15 集各自在规则状态记录中的条目也一致。

[下载生产回读证据](production-readback.tar.gz)。归档包含回读结果及实际文件、单集操作回执、前后生产 Git 树和规则状态，以及 `other-rules-comparison.json` 中的 15 集明细。

```sh
echo 'd31865e33edcd25285c879fa099a851bdde9bd94d831061ddefd1ecd2d022f08  production-readback.tar.gz' | shasum -a 256 -c -
evidence_dir=$(mktemp -d)
tar -xzf production-readback.tar.gz -C "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c SHA256SUMS)
```
