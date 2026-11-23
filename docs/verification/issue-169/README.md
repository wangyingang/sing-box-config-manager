# #169 v4 版本控制与 SRS 故障隔离验收

从空的 `acceptance-issue-169` 目标首次发布后，`status` 显示可选的当前版本，`pin` 固定该版本并跳过上游更新，`resume` 恢复自动更新并交付新版本的 JSON 和 SRS。订阅元数据使用 v3，对两种格式直接记录获取地址，省去 `projections`。

在同一次同步中，已有交付的规则集遇到 SRS 加载失败，上一版的 JSON 和 SRS 逐字节保留。首次交付的规则集遇到 SRS 编译失败，两种格式均未发布。另一有效规则集在同一个提交中交付两种格式。结果按规则集记录，自动同步返回退出码 1，沿用 Actions 原生失败路径。

测试使用实际 sing-box 1.14.4、受控上游和内存产物目标。验收覆盖工作流失败退出码。实际 GitHub 产物发布和邮件投递未执行。正式 16 集配置迁移由 [#174](https://github.com/wangyingang/sing-box-config-manager/issues/174) 跟踪。

| 证据目录 | 源码提交 | 验证范围 |
| --- | --- | --- |
| `d42f6ad/` | `d42f6ad7b28bde1ba4a2cf26a8fd094ddf7a7225` | 最终验收，干净工作区，`check-native`。446 项常规测试和 333 项原生集成测试全部通过，零失败、零跳过。 |
| `01e6097/` | `01e6097f4943458fee8594b36141921760d58548` | 实施期间的早期记录。最终验收以 `d42f6ad/` 为准。 |
| `d42f6ad-integrity/` | `d42f6ad7b28bde1ba4a2cf26a8fd094ddf7a7225` | 最终验收证据的文件完整性校验报告。 |

[证据包](evidence.tar.gz) 的 SHA-256 为 `4a8f4c7633509921491594d1b1e95c4464568f19218b8bb773741ab0f96c3c89`。解包后，`scripts/inspect-evidence.mjs` 可核对两份验收记录的统计、文件大小和摘要。

[PR #176](https://github.com/wangyingang/sing-box-config-manager/pull/176) 以 `e289da15d6180a1350902de5878bb02a7dd08b11` squash 合入 `main`，合并提交的文件树与受验 PR head 一致。[常规 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45158164508)和[独立 Linux 原生回归](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45158098366)均通过。[云端 Codex 审查](https://github.com/wangyingang/sing-box-config-manager/pull/176#issuecomment-7098302440)覆盖最终 PR head，无 findings 或未解决讨论。[#169](https://github.com/wangyingang/sing-box-config-manager/issues/169)已按 completed 关闭。
