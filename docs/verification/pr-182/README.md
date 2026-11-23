# PR #182 生产规则集回读验收

2026-11-23 使用生产 `status` 和真实 HTTPS GET 核对了 16 个规则集。每个规则集都有可选的当前候选，JSON 和 SRS 共 32 份。固定候选、固定交付、稳定订阅三个地址合计 96 次返回 HTTP 200，文件长度、SHA-256 和地址均与 #162 验收记录一致。`china-ip`、`chatgpt-voice` 的 `ips.json` 和 `ips.srs` 可读，两目录内原有的四个 `route.*` 地址均返回 HTTP 404。[PR #182](https://github.com/wangyingang/sing-box-config-manager/pull/182) · [原始验收 #162](https://github.com/wangyingang/sing-box-config-manager/issues/162)

| 验证对象 | Git 提交 |
| --- | --- |
| PR 最新提交 | `fae912027fcfdcc983e6143900f2c25941a02540` |
| 合并到源码仓库 main | `4e904ffcb3cfd00ab634ca94d0f104abfade02e4` |
| 生产 status 使用的规则配置 | `d0afd8461767904c7d2e9a981774869830d3142b` |
| 产物仓库 main（稳定交付） | `c234d4546ea967e56b9610943a554374e626c25b` |
| 产物仓库 candidates（候选记录） | `530b3f9e27a23427f06ae5c272d9da5ef26afa6e` |

使用 sing-box 1.14.4 的本地 `pnpm check` 通过 472 项测试及构建、workspace smoke。另行运行的回读定向检查通过 8 项。GitHub CI 的 Detect changes、Workspace checks 通过，完整 Native sing-box 作业按 PR 工作流条件跳过。云端审查覆盖 `fae9120`，没有待处理意见。[CI 运行](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45193318308) · [审查记录](https://github.com/wangyingang/sing-box-config-manager/pull/182#issuecomment-7103880819)

[证据归档](evidence.tar.gz) 包含以下文件。四份 JSON 保留原字节，工作区日志中的本机绝对工作路径统一写作 `<worktree>`。

| 文件 | 内容 |
| --- | --- |
| `status.json`、`actions-rule-result.json` | 独立采集的生产 CLI 原始状态与最终回读使用的 [Actions 状态归档](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45189802656)，两份输入指向相同的产物提交 |
| `delivery-readback.json`、`baseline-162.json` | #182 逐文件回读结果与 #162 的初始验收记录 |
| `workspace-check.log`、`workspace-with-binary.log` | 常规检查日志。前者有 2 项原生条件测试跳过，后者指定 1.14.4 后全部通过 |
| `targeted.log` | 回读工具定向检查 |
| `SHA256SUMS` | 以上 7 个文件逐项的 SHA-256 |

在本目录校验归档和解包后的文件：

```sh
echo '12bebce26d9d63683804c01a8c8f805b073f9690b38734f29a1a860419170664  evidence.tar.gz' | shasum -a 256 -c -
evidence_dir=$(mktemp -d)
tar -xzf evidence.tar.gz -C "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c SHA256SUMS)
```
