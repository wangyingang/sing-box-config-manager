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

最后一轮探针拒绝单文件重测为 8/8 通过；其余 14 项常规测试及原生编排单文件未再修改。显式入口在 `RULE_AUTOMATION_PROBE=0` 时为 0 通过、1 跳过，这是门禁测试，不是远端验收成功。当前测试没有对全仓库测试数或耗时作比较。

## 真实隔离验收

实现分支为 `codex/issue-100`，固定实现 commit 为 `6af9fe468d34a00921ceb40ee78e6dc9f1375804`，本地探针文件 SHA-256 为 `47c6154114216ab8a2d886c16772032711f05a5b894bf817e7132b10e85adfb5`。Node v26.13.0、pnpm 10.33.2；原生单文件使用 sing-box 1.14.4，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。

| 尝试 | 真实结果 | 清理与边界 |
| --- | --- | --- |
| 错误 SHA 参数 | 操作者首次录入的 SHA 与分支 head 不同；探针拒绝，没有创建 refs 或运行 | 生产前后相同，remaining/cleanupErrors 均为空；不是实际分支移动的观察 |
| remote-1 | 创建源码 blob 时 TLS handshake timeout，尚未触发 workflow | 已创建的产物隔离 ref 删除成功；生产前后相同，remaining/cleanupErrors 均为空 |
| remote-2：[baseline push](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44140058289/attempts/1) | 配置 push 已真实执行，run attempt=1；事件/工作流/checkout/configurationRevision 均为 `62e9688017a8c8fda70164b1196ffb5265543cff`，业务读取产物仓库时返回 HTTP 401 `Bad credentials` | 两个隔离 refs 删除成功；生产前后相同，remaining/cleanupErrors 均为空 |
| remote-3：更新独立凭据后 | baseline push、pin、混合修改、resume 预览/实际执行及 partial 失败均符合预期；最后请求旧事件 rerun 时网络 EOF，未取得旧事件重跑通过证据 | 六个阶段的真实业务证据保留；两个隔离 refs 删除成功，生产前后相同，remaining/cleanupErrors 均为空 |
| remote-4 | 七个阶段全部符合预期；单文件验收 1/1 通过，失败/跳过/取消/todo 均为 0 | 两个隔离 refs 删除成功，生产前后相同，remaining/cleanupErrors 均为空 |

remote-4 的隔离目标为 `acceptance-automation-b13da05c-faba-436c-a852-f82855603757`，真实 push/dispatch 生命周期已通过。业务刻意失败的两个 workflow 正确返回 failure，探针验证其结果后整体成功；不能将这些预期失败当作 CI 失败或漏报。没有更改生产 token、开关、refs 或执行生产操作。手工事件不代表真实 schedule 已观察或邮件已实收。

| 阶段及运行/attempt | 事件与结果 | 业务断言 |
| --- | --- | --- |
| [baseline-push / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44143942851/attempts/1) | push / success | 三集均 delivered，配置修订 `4548e7b` |
| [pin-fixed / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44144711702/attempts/1) | dispatch / success | fixed pinned，配置修订仍为 `4548e7b` |
| [mixed-push / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44145023048/attempts/1) | push / success | deleting deleted，changing/added delivered，fixed pinned-skipped 且版本保持；配置 `d97db93b` |
| [resume-preview / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44145617133/attempts/1) | dispatch / success | fixed planned，产物 head 不变 |
| [resume-fixed / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44145781962/attempts/1) | dispatch / success | fixed 恢复 auto 并交付新版本 |
| [partial-failure-push / 1](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44146179207/attempts/1) | push / failure（预期） | changing failed 且保留当前版本；added delivered 新版本，fixed unchanged；配置 `e8964855` |
| [old-event-rerun / 2](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44145023048/attempts/2) | 旧 push / failure（预期） | event/workflow SHA 保持 `d97db93b`，实际 checkout/configurationRevision 为 `e8964855`；changing failed、added/fixed unchanged，未恢复删除定义 |

所有 dispatch 的 event/workflow/checkout SHA 均为固定实现 `6af9fe4`。新 push 的三种 SHA 与该次配置 commit 相同；这些 commit 从固定实现派生，仅改变隔离配置与输入。每次配置完整 YAML、完整 SHA 和所有 JSON/摘要均保存在原始证据。remote-4 启动时本地仅本说明尚未提交，探针 SHA-256 与 `6af9fe4` 相同，没有未提交的受测代码变更。

最终生产对照：源码 main 为 `458f456733f2d1e9a25d158beffdfde6bb9bdc5a`，产物 main 为 `5dc92dbaa1a25b43eef79ff02fe760c90b1c52de`，candidates 为 `ea08a99a4a485ce479691f351626cbf6ab20d304`，Actions variables 均为空，前后完全相同。

[证据 manifest](issue-100/manifest.json) 与[原始归档](issue-100/evidence.tar.gz)保存定向日志、来源/工具身份、四轮远端结果、首次错误 SHA 的拒绝、每次配置、各运行及 attempt、执行身份与业务 artifact、生产对照及清理结果。原生单文件日志保留终端尾段（含完整统计），初始进度行只在工具记录中；该测试及其应用服务/fixture 在实现提交中均未修改。归档按文件摘要核对，不声称执行了统一全量验证或全仓库性能审计。

## 审查

本地 Standards 轴零 findings；Spec 轴零 findings，已核对完整 diff、旧断言去向、入口与门禁、维护恢复/pending 保护及实际执行身份的边界。两轴覆盖 `458f456...6af9fe4`，没有待处理意见。

云端 Codex 首轮已完成，覆盖 `6af9fe468d34a00921ceb40ee78e6dc9f1375804`，零 findings；review 正文、行内 comments 与全部 review threads 已核对，均无待处理意见。CI 未运行，不能表述为 CI 通过。此后追加的验证记录另作证据提交，不冒充已被该轮云端审查覆盖。
