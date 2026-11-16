# Issue #84：配置驱动交付与版本控制验收

日期：2026-11-16。需求：[Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84)。本次实施在 `codex/issue-84` 独立 worktree，基于 `origin/main@8ad4bcc2317bbade100e8426af0b23b32cec0d20`；交付停在 PR 待审阅，不执行生产转换、启用、清理或合并。

## 行为覆盖

| 验收 | 执行场景与证据 |
| --- | --- |
| A01 新增 | `rules-inputs.test.ts` 使用不同仓库、资产、分支和路径，分别验证 Release/Git 与 plain-yaml/cidr-text 四种组合，真实 sing-box 编译、复验及 pin |
| A02 换源 | 同 ID 换仓库/list，失败保留旧实际交付并撤销 pin，下一次 sync 成功；别名修改不撤销 pin；仍可明确选择旧来源版本 |
| A03 删除 | 单集、全部集、重跑及重新新增；检查稳定文件、activation 和候选索引消失；已改变但不兼容的期望路径不会导致旧记录遗漏 |
| A04 固定 | 固定旧/当前版本、重复 pin；固定集不请求其独立上游；同源兄弟集继续；新定义不能覆盖其他规则仍在交付的稳定路径 |
| A05 恢复 | resume 立即更新；来源失败仍为 auto；控制修订改变后不恢复被 pin 取代的旧候选任务 |
| A06 混合变更 | 同批新增、换源失败、删除，独立成功保留，整体 partial；正常重跑完成 |
| A07 输入错误 | 无效配置、无效 pin、草稿写入均零业务写入；首次来源失败报告 not-delivered；兼容性失败保留原交付 |
| A08 查询/预览/重跑 | status 和三个写操作 dry-run 零写入；无变化不新增候选；同一时间不同候选版本身份不覆盖；双分支提交回复丢失、HTTPS 待核实和换机恢复保持同一版本 |
| A09 转换 | 旧状态样本保留稳定字节、真实来源和有效固定；换源后旧固定失效；缺失历史时间标 migrationPending；转换预览零写入；双分支转换中断后恢复；未完成候选保留隔离索引，按归属删除，未知归属保持 pending |
| A10 入口 | CLI/Node API/隔离 Action 共用四个应用服务；JSON/退出码/预览一致；公开 exports 仅四个函数；help 和现行文档移除旧业务入口 |

核心场景位于 [规则操作集成测试](../../packages/rule-set-pipeline/test/integration/rules-operations.test.ts)、[输入组合测试](../../packages/rule-set-pipeline/test/integration/rules-inputs.test.ts)、[迁移测试](../../packages/rule-set-pipeline/test/integration/rules-migration.test.ts)和[CLI/Action 集成测试](../../packages/rule-set-pipeline/test/integration/rules-cli.test.ts)。原有来源身份、原生验证、稳定订阅、维护隔离和恢复测试继续作为内部回归，不把旧公开语义重新导出。

## 统一本地验证

执行 `node scripts/verify.mjs --out .verification/issue-84-local-1 --binary <本机 sing-box 1.14.4 绝对路径>`，范围 `check-native`，结果 `passed`。源码身份来自本次 summary：base commit `8ad4bcc2317bbade100e8426af0b23b32cec0d20`、`clean=false`、tracked diff SHA-256 `9060fba55732438a40e9fe0550543d262da069164981298b67819ff6b11052d9`，包含本 PR 尚未提交的实现与测试。统一验证后补充共享状态损坏零写入及换机恢复修复，针对验证见下节；最终提交身份由 PR 的 CI 验证。

- Node.js `v26.13.0`、pnpm `10.33.2`、sing-box `1.14.4`；binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。
- 常规检查：工具 115、Compiler 99、Pipeline 155，共 369 项通过；类型检查、build 和 workspace smoke 通过。
- 原生集成：Compiler 28、Pipeline 216，共 244 项通过。
- 合计 613 项通过，0 失败、0 取消、0 跳过。原始 summary 和日志保留在任务 worktree 的 `.verification/issue-84-local-1/`。
- 未额外运行 `--release` 固定官方全量构建套件；本次另有下述真实 GitHub 生命周期探针，不把它计入统一入口的 613 项。

## 真实 GitHub 隔离探针

运行 [rules-operations.test.ts](../../packages/rule-set-pipeline/test/acceptance/rules-operations.test.ts)，启用 `RULE_OPERATIONS_PROBE=1` 和真实 sing-box 1.14.4。使用真实 GitHub 发布及 HTTPS 回读；来源发现固定到官方 `20261104112839` Release，来源字节和摘要均从 GitHub 读取。正式配置通过受限测试上下文提供，不用本地文件授权生产写入。

成功目标：`acceptance-issue-84-729e4167-7f57-41b8-95a2-6a129894d0dc`，结束时间 `2026-11-16T14:32:35.646Z`。1 项通过，0 失败，0 跳过，约 435 秒。

| 操作 | 实际交付版本 | 核验后的隔离 head |
| --- | --- | --- |
| 新增 | `2026-11-16T14:26:48.962Z~7a636574` | `c09574456525116c0804db40f8b353e2ddf8dfe0` |
| 换列表 | `2026-11-16T14:29:03.719Z~d6e09fd5` | `f2c3fad757bd466c73522095ed713a75cd801b28` |
| pin | `2026-11-16T14:26:48.962Z~7a636574` | `9c342b52a65c7e033e6b8ed7cb3e8b1d59006340` |
| resume | `2026-11-16T14:29:03.719Z~d6e09fd5` | `11013399880f21c595268dcd03fe2bb42676814f` |
| 删除 | 无稳定交付/候选 | `ddfdf7d9a7ca1f6d24e83abb1f0c176739dd6946` |

探针结束后删除自己的临时 ref，并核对生产 refs 与源码仓库 Actions variables 前后一致：产物 `main=ae3cf588169226618eb30271f123c29608eb754a`，`candidates=2b74039505116d84688a379bfe04d25ae76f4350`；变量列表为空，未设置或开启任何开关。前两次探针遇到来源网络 `fetch failed` 后退出，均清理自己的临时分支并通过生产状态不变检查；第三次使用 `gh` 下载固定 Release 资产后全程通过。完整操作与生产前后状态 JSON 保留在任务 worktree 的 `.verification/issue-84-github/`，失败记录未改写为成功。

## 本地审查修复

独立审查发现并修复五项问题，均通过真实 sing-box 与内存 Git transport 复验：

1. 新规则可能占用另一个规则尚在交付的旧路径：现按实际稳定记录检查归属和路径重叠。
2. 不兼容的期望路径被接受后，删除可能遗漏旧 activation：现定位实际已交付记录再删除。
3. pin/resume 可能采用被旧控制决定取代的在途候选：恢复必须匹配候选登记时的 control revision。
4. pinned 跳过及 status 可选候选缺少完整订阅兼容检查：现报告失败和不可选原因，保持真实当前交付。

5. 稳定字节损坏时 sync/resume 会先保存定义或解除固定：现将稳定交付完整校验前移，损坏时不保存任何控制或定义变化。

## 云端首轮审查与补充验证

云端首轮审查覆盖 `7e8edb888ac4bb559d339fb7482d6a9e95eaf1a7`，提出 [1 项 P2](https://github.com/wangyingang/sing-box-config-manager/pull/87#discussion_r4587135789)：证据提交后回读中断，换机安装路径不同会导致重生成的诊断路径与保留证据不一致，卡住后续同步。

修复优先复验远端已保留的完整证据，不重新获取上游或生成证据；保留同一候选、版本与发布时间。元数据阶段已提交但返回的 commit 尚未保存时，先从实际保留文件恢复阶段指针，继续保留原始 build 记录的诊断路径。

- 共享状态损坏保护与证据恢复合并验证：规则操作套件 12 项通过，0 跳过。
- 随后扩展 evidence/metadata 两个阶段的换机用例：复制相同 sing-box binary 到不同绝对路径，2 项针对测试通过，0 跳过；原证据/构建记录逐字节保持不变。
- 修复后 typecheck、`git diff --check` 通过。日志保留在任务 worktree 的 `.verification/issue-84-review/`。最新 CI 和第二轮云端覆盖提交以 PR 交付记录为准。

## 范围与待部署事项

- #85 的保留期清理和 #86 的 push/schedule/原生失败通知尚未实施。Action 仅开放 `acceptance-*` 手动隔离入口，明确拒绝生产目标。
- `candidateRetentionDays: 30` 当前是待管理者确认的示例值，不是已批准的生产策略；本轮没有执行清理。生产转换前应以明确选择的正式配置执行预览。
- 内部转换入口不公开为旧命令兼容层。缺少可靠原始发布时间的历史候选保留证据及当前交付，标记迁移待处理，不编造正常时间版本，也不按年龄清理。
- 没有运行生产转换或原生 Actions 自动触发验收。最终提交的 CI 与云端审查状态记录在 PR/Issue 交付评论，避免为状态刷新新增源码提交。
