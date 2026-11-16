---
status: accepted
---

# 通过正式配置协调规则交付与版本控制

2026-11-16，依据 [Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 及其引用的交接文档，将管理者日常操作收敛为 status、sync、pin、resume。管理者提交正式配置表达新增、换源和删除，sync 统一协调并交付合格版本；pin 同时选择版本并停止该集全部上游自动处理，resume 保存 auto 后立即更新。这样管理者无需拆解候选发布、激活和重试阶段，也不会因人工指定与回滚的暂停含义不同而误判后续行为。

## 意图、控制与交付分别保存

换源后即使新来源失败，期望定义仍是新源，控制仍为 auto，而实际交付保留旧源版本。输入绑定比较上次已接受的期望定义，不与实际交付来源混同。只有实际仓库、获取/解析方式和列表等输入语义改变才撤销旧 pin；别名和排版调整不影响控制。独立规则集允许部分成功，共享写入不确定时停止相关写入并核实原操作。

正式配置以源码 main 当前已推送 commit 为权威，关键提交前重新核对。草稿仅供只读预览，旧 checkout 或旧事件不获得重放旧定义的权力。版本控制、规则代次、操作身份、预期 head 和维护代次保留并发与恢复边界；相同 ID 删除后重建不继承旧任务。

## 保留的跨模块边界

本决策替代 [ADR 0006](../../../../docs/adr/0006-follow-active-rule-subscriptions.md) 及 Spec [#47](https://github.com/wangyingang/sing-box-config-manager/issues/47)/[#66](https://github.com/wangyingang/sing-box-config-manager/issues/66) 中旧公开操作和双暂停安排。稳定 Rule Subscription、Recipe 跟随当前交付、订阅兼容检查、Compiler 纯内存边界和 sing-box 原生更新机制继续有效。管理者 pin 影响该集所有订阅使用者，Recipe 不增加固定版本选项。

## 成本与交付边界

移除旧公开命令与 Node API，不保留长期兼容层；内部构建、发布、复验及转换能力继续复用。配置和操作状态升级，已有远端状态需要一次性受控转换，保留稳定 URL、字节、来源和有效固定。无法可靠恢复的历史发布时间明确待处理，不能以迁移时间充当真实发布时间。

候选清理属于 [#85](https://github.com/wangyingang/sing-box-config-manager/issues/85)，push/schedule 与 GitHub 失败通知属于 [#86](https://github.com/wangyingang/sing-box-config-manager/issues/86)。这些拆分会要求后续同步维护调用方和验收证据；本次不接入未完成的生产编排、不执行生产转换。历史验收保留原日期与事实，当前完成状态以对应 PR 和工单交付记录为准。
