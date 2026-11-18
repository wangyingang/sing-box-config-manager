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

候选清理决定见 [ADR 0002](0002-retained-history-cleanup.md) 和 [#85](https://github.com/wangyingang/sing-box-config-manager/issues/85)，push/schedule 与 GitHub 失败通知见 [ADR 0003](0003-automated-operations-and-native-notifications.md) 和 [#86](https://github.com/wangyingang/sing-box-config-manager/issues/86)。#84 阶段没有接入生产编排或执行生产转换；后续接线仍遵守独立的环境门禁和生产授权。历史验收保留原日期与事实，当前完成状态以对应 PR 和工单交付记录为准。

[#125](https://github.com/wangyingang/sing-box-config-manager/issues/125) 的原生策略切换采用空产物状态。旧开发期候选、稳定订阅、证据和运行状态可清除。新候选由正式配置首次 sync 建立，使用编译和两种格式的真实加载，固定地址与订阅交付继续校验实际字节。旧状态转换建议适用于上文早期操作升级。

[#128](https://github.com/wangyingang/sing-box-config-manager/issues/128) 为每集记录最后一次确认成功的输入。若来源更新只改变其他列表，系统核对本集的规范化内容、用途、工具和完整交付后跳过原生构建，更新成功输入记录并保留原交付来源。成功记录与交付一起完成，或在已核实继续使用旧交付后单独保存。候选缺失、当前版本不符或处理条件变化时回到常规流程。共享稳定文件与交付摘要不符时停止写入。
