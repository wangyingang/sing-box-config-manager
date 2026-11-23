# #174 正式 v4 联合验收

2026-11-23 使用正式配置和实时上游，从 `wangyingang/sing-box-rule-artifacts` 的空隔离分支 `acceptance-issue-174-c32b875d-88fe-4208-a15e-7f97c3e4a101` 开始。初始提交为 `62fd21f9bc7f42c32d54993d6fab482fb0c3d32e`，树中只有 README。配置 SHA-256 为 `3aedd0646369d377bd8825d64c30be9a407a775262f0d7b155a29859a824c857`。

- 16 集均已交付，各有一个可选候选。基线测试核对 ID、基名和稳定路径，保留 `target` 和 30 天候选保留期。
- 对同一输入的 52,156 个独立匹配条件逐项对照旧版选择结果。核对固定 Git 文件的仓库、分支、commit、路径和正文摘要，并核对固定 URL 的来源地址及留档正文摘要。
- 对 32 个文件，固定候选、固定交付及稳定分支三个 HTTPS 地址均与 Git 文件字节相同。用 sing-box 1.14.4 原生加载两种格式，66 次匹配均符合预期。交付流程记录了 64 次规则文件回读。
- 对 OneDrive 执行 `pin` 和 `resume`，确认控制从 auto 切换到 pinned 再回到 auto。计划预检识别全部 16 集。清理预览保留全部 16 个候选，回收候选数为 0，隔离 head 保持原值。
- 隔离分支已删除，生产 `main`、`candidates` 和更新／清理门禁的前后记录一致。生产切换由 [#162](https://github.com/wangyingang/sing-box-config-manager/issues/162) 独立跟踪。

| 记录 | 源码身份 | 核验范围 |
| --- | --- | --- |
| `formal-v4-github.json`、`formal-v4-write-observation.json` | `e5f68fa`，证据登记工作区状态和 diff 摘要 | 从空提交开始。YouTube 报写后状态冲突，固定 Git 记录证明该交付与成功输入已落盘。 |
| `formal-v4-continuation.json` | 干净的 `e5d8537` | 从同一提交链续跑，原 11 个候选身份保持。恢复 stream 在途交付并重试上游 HTTP 503 后，16 集同步成功。该轮查询遇到一次 Git 发布阶段读取失败。 |
| `formal-v4-final.json` | 干净的 `3b827fb` | 用已完成同步的固定提交复核候选、来源、匹配、稳定交付、pin、resume 和预检。 |
| `formal-v4-cleanup.json` | `295c9d5` | 补齐传输后，从固定预检提交执行只读清理。服务返回 `success/unchanged`。补验脚本原先误将阶段期望为 `preview`，已按契约复核记录、候选集合和 head。 |
| `check-native-a52f84e/` | 干净的 `a52f84e` | `check-native`，470 项常规测试和 347 项原生集成测试通过，零失败，零跳过。 |

[Linux 完整原生回归](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45175433283) 在 `cbace21` 通过。后续提交调整隔离探针、历史夹具和文档。探针用法见 [Pipeline 自动化验证](../../../packages/rule-set-pipeline/README.md#自动化验证)。

[证据包](evidence.tar.gz) 的 SHA-256 为 `cd827876d8504d3caf0ae73f3fcbc75549e3b0ae49d8cda0ab79b18e4f87c83c`。
