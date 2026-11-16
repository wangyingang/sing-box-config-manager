# Issue #86：自动运行与 GitHub 原生失败通知验收

日期：2026-11-17。需求：[Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86)。实现基于 `origin/main@1ed2ab1af412199262e25c146b64938947580364`，工作分支 `codex/issue-86`。交付停在 PR 待审阅，不启用生产开关，不执行生产转换、发布或清理。

## 行为与证据

| 验收 | 检查及边界 |
| --- | --- |
| C01 配置 push | 正式 main 配置及同名 acceptance 隔离配置 push 调用完整 sync；真实混合变更触发证据待隔离探针补录 |
| C02 自动控制 | 原生编排验证 auto 更新、pinned 跳过、resume 后交付当前来源；复用共享业务层 |
| C03 日常维护 | 原生样本中断 cleanup 后，schedule 先续做原计划再访问上游；同步部分失败仍保留安全清理结果且整体失败 |
| C04 五入口 | CLI、Node API、workflow_dispatch 共用五操作；无关参数拒绝，预览零写入；不增加 daily 公开命令 |
| C05 失败映射 | 普通来源失败与部分成功返回非零；pending/共享冲突停止后续写入，后续 cleanup 成功不能覆盖失败 |
| C06 原生通知 | 已只读核对账号 Actions 为 Email / Failed workflows only；未改变设置，邮箱实收未验证；文档提供官方设置路径 |
| C07 门禁与修订 | 更新与清理默认关闭且独立；disabled 返回当前配置修订和未应用，不读取旧生产 journal。每次读配置解析分支当前 head；真实旧事件重跑及生产前后对照待探针补录 |
| C08 交付核对 | 根 help、五个 Node 导出、CLI、Actions、README 与模块 ADR 对齐；保留 A/B 的历史验收记录 |

针对门禁与当前配置 5 项常规测试通过，工作流适配器 13 项常规测试通过，编排原生集成 1 项通过（0 跳过）；这些结果不替代后续统一验收及真实 GitHub 触发。

## 本地统一验收

统一入口正在执行，结果待补录。未完成的检查不记为通过。使用 sing-box 1.14.4，不运行固定官方 Release 全量构建套件。

## 真实 GitHub 隔离验收

探针限定一个同名 acceptance-issue-86-* 源码配置分支与产物分支。计划覆盖基线 push、pin、混合新增/换源/删除 push、resume 预览与实际执行、部分失败 push 和旧事件 rerun；来源为该隔离分支上的小型真实 CIDR 文件。保存原生事件、运行链接、实际配置修订及结果 artifact；前后核对生产 refs/Actions variables，最终清理本次隔离 refs。当前尚未执行，不记为通过。

## 限制与部署边界

未观察原生 schedule 事件，定时编排通过本地真实业务层测试验证；cron 沿用每日 `23 20 * * *`（北京时间次日 04:23）。原生邮件按账号设置及 GitHub 平台行为工作，不承诺固定收件人、准时触发或邮箱必达。账号只读设置观察保存在本地 `.verification/issue-86-notifications.json`，不保存收件地址。

生产仍默认关闭，旧生产状态转换与正式启用需另行授权。本次只验证隔离目标，不以合并或 CI 成功表示生产已上线。最终 CI 与云端审查覆盖提交更新在 PR/工单交付记录中。
