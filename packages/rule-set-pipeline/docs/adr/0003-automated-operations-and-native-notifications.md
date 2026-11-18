---
status: accepted
---

# 自动运行共享五个操作，失败通知交给 GitHub

2026-11-17，依据 [Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86)，正式配置 push 调用完整 sync，每日计划组合 sync 与 cleanup，手工 Actions 继续使用 status/sync/pin/resume/cleanup。三种触发都调用既有应用服务，不另建自动更新业务层；旧事件重跑读取当前正式配置，防止恢复已删除的定义。活动维护先通过 cleanup 继续，确认可写后才更新；独立失败保留已完成变化，运行整体仍失败。

生产更新与历史清理由两个默认关闭的环境门禁分别控制，CLI、默认 Node 宿主和 Actions 遵守同一边界。disabled 明确表示未应用，不与单集 pinned 混同。隔离 push 使用源码 acceptance 分支和同名产物目标，不能将测试配置或测试事件路由到生产。工作流的同目标排队继续配合应用服务的配置修订、head 与 generation 校验。

本轮用户选择 GitHub Actions 原生失败邮件，替代交接文档中显式收件人、自定义业务邮件和启动失败通知兜底的建议。业务服务把 partial、failed 和未解决 pending 映射为失败；摘要与 JSON artifact 保存实际交付、控制状态和继续入口。项目因此无需邮件账号、发送服务、队列或重试逻辑，但也不承诺固定收件人、每次失败必达或平台漏触发时仍能通知。手工 dry-run 失败同样可能触发账号配置的原生通知，预览自身不发送邮件。

通知对象和内容由 GitHub 及账号设置决定；定时任务通知对象还与创建、修改 cron 或重新启用工作流的人有关。保留期只决定候选年龄，计划只决定执行频率，两者不互相替代。历史 Spec #47/#66 的记录保持原事实；生产转换、开关启用、原生 schedule 观察和邮箱实收须依据部署授权与实际证据记录，不能由代码交付推断完成。当前操作与设置见[模块 README](../../README.md#actions-自动与手工运行)，交付状态以 Spec #86 的 PR 和验收记录为准。

[#138](https://github.com/wangyingang/sing-box-config-manager/issues/138) 为操作结果记录本次实际发起的产物 Raw 请求。人工 status 用 Git 检查保留候选及稳定交付，预览也只在各自只读边界内检查。定时运行中的待恢复写入继续按 sync 或 cleanup 的持久阶段推进，完成必要规则回读后才确认成功。
