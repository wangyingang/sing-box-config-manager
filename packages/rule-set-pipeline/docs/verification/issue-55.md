# Issue #55 工作流运行与验收

[工单 #55](https://github.com/wangyingang/sing-box-config-manager/issues/55) 的工作流独立于 CI。每日运行在 UTC 20:23（北京时间次日 04:23）计划触发，也可在 Actions 中选择 **Rule set maintenance** 后手动运行。

| 触发 | 操作 |
| --- | --- |
| 每日 | 调用 `checkRules`（与 `check-now` 共用入口），然后由 `maintenance-enter` 的现有规则判断是否可清理。 |
| 手动 `check` | 立即检查，保留现有 pin。 |
| 手动 `cleanup` | 立即评估清理条件，无需等待周期。取得隔离、核实保留集合后才准备和切换基线。 |

## 启用与权限

生产更新和生产清理分别由仓库变量 `RULE_UPDATE_ENABLED`、`RULE_CLEANUP_ENABLED` 控制。仅值为 `true` 且工作流从 `main` 运行时允许对应生产操作。两项变量默认留空。自动清理还需同时设置 `RULE_CLEANUP_PERIOD_DAYS`（正整数）和 `RULE_CLEANUP_START_AT`（UTC，例如 `2026-11-07T00:00:00Z`）。未设置周期时每日自动清理关闭。周期表示计划间隔，清理范围由维护操作确定。

手动输入 `target` 可以选择已创建、已初始化的 `acceptance-*` 产物分支。隔离运行独立于生产开关。工作流使用[版本化的正式配置](../../config/rulesets.yml)和 v2 Rule Subscription，稳定 URL 绑定所选产物分支。上线前需核对生产稳定地址和订阅契约，显式初始化对应远端状态。

为工作流提供 Actions Secret `RULE_ARTIFACT_TOKEN`。凭据需要在可信产物仓库读取 Git 对象、写入目标 refs 并在清理时更新和删除本次维护所用的 refs。上线前先在隔离目标确认日常非强制更新及清理原子更新权限。源仓库的工作流 token 仅用于只读查询，产物写凭据只传给执行步骤。不要把凭据放入配置、手动输入、订阅 URL 或调试日志。

## 查看结果与恢复

每次运行在 Summary 和 `rule-maintenance-summary` artifact 中保存实际检查的 Release／Git commit、每集检查结果、当前交付版本、pin、回滚目标及已知失败或待核实操作。维护结果另列周期、阶段、保留版本、拟清理数量、延期原因和仍保留的其他引用。检查有实际失败或待核实时运行失败，其他集已完成的结果仍保留。正常暂停、未到期、无须清理或安全延期可从摘要区分。

- 检查失败时，先看 Summary 和产物目标的 `status`。未决更新使用相同目标和配置重新运行 `check`；远端日志核实前不要删除记录或切换目标。
- 维护隔离后中断时，先以原目标运行 `maintenance-resume`。如仍处于切换前，按已记录阶段执行 `maintenance-prepare` 或 `maintenance-switch`，或按维护 ID 安全退出。切换后从远端记录继续核验和收尾。详见 [维护隔离与切换](../../README.md#预览清理与维护隔离)。
- GitHub Actions 同一产物目标的运行使用同一并发组，保留正在执行的任务。GitHub 仍可能替换排队的运行。CLI 和 Actions 的实际写入都受远端协调约束。取消或超时后仍须核实远端，随后才能继续维护。
- 检查 Actions 的最近一次 `schedule` 运行及其 Summary。GitHub 定时任务可能延迟或漏触发，公开仓库长期无活动时也可能被停用。确认工作流已启用、定时 actor 仍有效后，可用 `gh workflow enable rule-maintenance.yml` 恢复，并手动 `check` 补一次检查。[GitHub 定时触发说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- 管理者在 GitHub 的通知设置中启用 **Actions → Email → Only notify for failed workflows**。上线前核对定时任务关联的账号，以及手动运行的触发者。定时通知发给当前定时 actor。[设置失败通知](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications) · [通知接收者](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
