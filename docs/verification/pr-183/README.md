# PR #183 规则订阅契约迁移验收

Rule Subscription v2 的说明、Schema 和示例已移至 `packages/config-compiler/contracts/`，v1 已归档到 `docs/history/rule-subscription-v1/`。在合并提交上复核，迁移的两份 Schema 和两份示例与原文件逐字节相同。Pipeline 独立安装的实测记录显示，仅提供它声明的三个运行时依赖，也能加载公共入口、读取正式 v4 配置并校验 v2 示例。[PR #183](https://github.com/wangyingang/sing-box-config-manager/pull/183)

| 版本 | Git 提交 |
| --- | --- |
| 迁移前的共同基点 | `d0afd8461767904c7d2e9a981774869830d3142b` |
| 通过 CI 及云端审查的 PR 提交 | `db69c5773dd4f8974d2a64c54590982970ddddcd` |
| 合入 main 的提交 | `c0357262062508a5cdfa99999c88694caa84367d` |

本地使用 sing-box 1.14.4 运行 `pnpm check`，工具测试 167 项、Compiler 测试 99 项、Pipeline 测试 204 项，合计 470 项全部通过。类型检查、构建和 workspace smoke 也通过。另行运行的 20 项 Compiler 订阅定向测试全部通过。PR 的 Detect changes 和 Workspace checks 通过，Native sing-box 作业按工作流条件跳过。云端审查覆盖表中 PR 提交，未提出问题。[PR CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45197322559) · [审查记录](https://github.com/wangyingang/sing-box-config-manager/pull/183#issuecomment-7104495080)

[下载验收证据](evidence.tar.gz)。归档保留了验收时的 7 个文件，另附合并后核对的 `schema-files.json`。日志中的本机工作目录统一写作 `<worktree>`。

| 文件 | 用途 |
| --- | --- |
| `workspace-final.log`、`workspace.log` | 最终 PR 提交的工作区检查输出及前一轮输出 |
| `compiler-subscriptions.log`、`standalone.log` | Compiler 定向测试结果及独立安装 Pipeline 的验证结果 |
| `check-links.py`、`links.json` | 在任务分支采集的链接检查脚本及结果，165 个本地链接和 4 个历史提交链接均可解析。脚本按运行时的 `origin/main...HEAD` 选择变更文档 |
| `pr.md` | 当时的 PR 说明与验收范围 |
| `schema-files.json` | 四个 JSON 文件的迁移前后路径、字节数与 SHA-256。已对照共同基点、PR 提交及合并提交 |
| `SHA256SUMS` | 归档中 8 个证据文件的逐项校验值 |

在本目录运行以下命令可验证归档及其内容。

```sh
echo '6ddc80b706567e0111c686da08be5b9dca98faabd1870dbf1c6d645df5355561  evidence.tar.gz' | shasum -a 256 -c -
evidence_dir=$(mktemp -d)
tar -xzf evidence.tar.gz -C "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c SHA256SUMS)
```
