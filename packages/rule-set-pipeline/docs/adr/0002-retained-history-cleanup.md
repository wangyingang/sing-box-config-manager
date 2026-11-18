---
status: accepted
---

# 按首次发布时间保留候选，用一个 cleanup 完成历史维护

2026-11-16，依据 [Spec #85](https://github.com/wangyingang/sing-box-config-manager/issues/85)，将历史维护收敛为 `cleanup`。管理者显式配置 `candidateRetentionDays`；候选首次成功发布的时间达到本次 UTC 截止边界时仍保留，实际当前版本与 pin 目标不受年龄限制。候选退出当前身份后继续按原发布时间判断，避免把长期固定误解为延长所有旧版本的保留期。本决策替代 Spec [#47](https://github.com/wangyingang/sing-box-config-manager/issues/47)/[#66](https://github.com/wangyingang/sing-box-config-manager/issues/66) 中只保留当前版本、没有最低保留期的安排；历史验收事实不改写。

维护使用现有原子引用切换能力，保留 candidates/main 双分支布局及隔离单分支支持。新的发布基线复制所有保留候选的完整证据，当前指针按明确候选身份恢复；业务版本、首次发布时间、实际来源与稳定订阅字节保持不变。这样清理后仍可选择窗口内的非当前版本，而受管分支不再可达旧操作历史。其他分支和标签只报告，不删除；GitHub 物理回收时间不在此保证内。

维护隔离与截止时间、保留集合在同一远端检查点登记。恢复沿用该计划，不因跨日或配置保留期改变扩大本轮删除范围。每次关键写入仍核对当前配置权威和远端 heads；切换后核验新基线、完成 HTTPS 回读与临时引用清理，才重新开放写入。管理者只需再次执行 `cleanup`，无需选择准备、切换或恢复阶段。查询和预览不推动维护；普通 sync 不顺带清理。

完整但发布时间未知的迁移候选，以及仍可能恢复的在途操作，会明确阻塞清理。只有已由新定义代次或控制决定取代、且不属于当前或 pin 目标的未完成操作，才可在维护隔离后作为失效残留回收。不能用清理时间补造发布时间，也不能用旧维护计划绕过新状态约束。

多版本保留增加了存储量和原生复验成本；新基线需改写物理证据地址，并保留业务身份，因此不能只删除目录文件。实现复用现有传输与原生验证，不增设数据库、调度平台或 plan/apply 审批流程。正式配置已确定为 30 天，自动调度和失败通知的决定见 [ADR 0003](0003-automated-operations-and-native-notifications.md) 与 [#86](https://github.com/wangyingang/sing-box-config-manager/issues/86)；生产转换、历史重写与启用仍需独立授权。当前验证与交付状态见 [#85 验收记录](../../../../docs/verification/issue-85.md)。

[#125](https://github.com/wangyingang/sing-box-config-manager/issues/125) 启用后，维护从新策略生成的历史中选择保留候选，沿用相同的保留与恢复规则。清理保留原构建工具和验证步骤，并记录新物理地址的字节核对及复验工具。

每次调用 `cleanup` 时，准备基线、切换前复验和切换后回读可复用本次已建立的原生验证证明。各阶段仍验证固定地址、实际字节、保留树和引用租约。恢复已有检查点时，需要原生验证的阶段从本次调用取得证明。[#126](https://github.com/wangyingang/sing-box-config-manager/issues/126)

准备、切换前复验和切换后核对可在一次 `cleanup` 内复用已校验的固定地址字节。重写后的地址首次真实下载，切换后的稳定分支入口继续通过 HTTPS 回读。当前保留树、基线身份与引用租约仍逐阶段核对。缓存容量和固定地址的可用性观察见[证据回读](../../contracts/rules-operations.md#证据回读)。[#127](https://github.com/wangyingang/sing-box-config-manager/issues/127)
