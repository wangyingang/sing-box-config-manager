# #100 自动化验收迁移

2026-11-18。实施起点 `458f456`，父 Spec #93。此映射在编辑测试前保存。固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4` 复用 [#94 同环境证据](issue-94.md#整理前测量与验证)，不重复执行。用户限定只运行本票相关测试，禁止完整测试、完整原生测试和 CI。

## 旧断言 → 当前契约 → 覆盖 → 退役依据

| 旧断言 | 当前契约与覆盖落点 | 退役条件 |
| --- | --- | --- |
| legacy-workflow：四集稳定 URL、域名 Route/DNS Query 与 CIDR Route/DNS Response 复用 | 当前 configuration/configuredSubscriptions；迁入独立配置测试，覆盖 main 与隔离目标 | 替代断言通过后删除旧项 |
| daily/check/cleanup 默认关闭 | rule-workflow 的独立生产更新/清理门禁、disabled 与配置修订 | 已有当前测试通过后退役旧 daily/check |
| daily/check 共享结果、pending 整体失败 | rule-workflow 的 push/schedule、partial/pending 与结果保留 | 当前测试通过后退役双暂停与旧结果字段 |
| 手工 enter/prepare/switch 失败及维护 ID 跟随 | 当前 cleanup 单入口；rule-workflow 的维护恢复优先与失败停止 | 旧阶段式编排已被替代 |
| 旧 schedule 决定 not-due/no-cleanup/deferred | 当前 schedule 调用 sync/cleanup；保留策略由 cleanup 决定 | 不再验证已退役的旧周期参数 |
| 旧 switch 尚未核实、pending blockers、inspection error 失败 | rule-workflow 的活动维护未解决、共享 pending、不可读状态停止写入 | 当前拒绝保护通过后退役旧状态字段 |
| codex/issue-86 默认值与固定断言 | 显式受审查 branch + 完整 SHA；探针外部 gh 边界拒绝缺参数、head 移动、运行/工作流/checkout SHA 不符 | 定向拒绝测试通过，真实 push/dispatch 另行验收 |
| 原自动化探针的隔离分支、生产 refs/变量对照、混合修改、pin/resume、partial、旧事件重跑 | 当前 rules-automation 显式入口继续覆盖并保存配置、运行 attempt 与执行身份 | 不削弱原断言；手工事件不代表真实 schedule 或邮件实收 |

`fixtures/legacy-workflow.ts` 编辑前只有旧 suite 一个调用者；替代配置断言及当前 workflow 测试通过、旧 suite 删除后重新扫描，无调用者才删除 fixture。

## 验证状态

迁移后的配置订阅断言、当前 workflow 常规保护及探针拒绝测试共 22 项通过，0 失败/跳过/取消/todo。探针通过实际子进程调用，在外部 `gh` 边界模拟缺参数、缩写 SHA、初始 head 不符、运行中 head 移动、push/dispatch 事件 SHA 不符、工作流 SHA 不符和 checkout SHA 不符；这些是本地故障模拟，不是真实 GitHub 故障。

单文件 `test/integration/rule-workflow.test.ts` 使用真实 sing-box 1.14.4，1 项通过，验证 pin/resume、维护恢复先于上游访问、部分失败保留成功交付。Pipeline `tsc --noEmit` 及 workflow YAML/Bash 语法检查通过。替代断言通过后删除旧 suite 的订阅项和七项旧编排测试，重新扫描没有调用者后删除 legacy fixture。完整测试、完整原生测试和 CI 按用户限制不执行。

真实 push/dispatch 隔离验收待执行；源码身份、运行/attempt、配置与清理结果另行追加。手工事件不代表真实 schedule 已观察或邮件已实收。
