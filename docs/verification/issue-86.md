# Issue #86：自动运行与 GitHub 原生失败通知验收

日期：2026-11-17。需求：[Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86)。实现基于 `origin/main@1ed2ab1af412199262e25c146b64938947580364`，工作分支 `codex/issue-86`。交付停在 PR 待审阅，不启用生产开关，不执行生产转换、发布或清理。

## 行为与证据

| 验收 | 检查及边界 |
| --- | --- |
| C01 配置 push | 正式 main 配置及同名 acceptance 隔离配置 push 调用完整 sync；真实混合 push 已同时完成新增、换源、删除，固定集保持原版本，见第五轮记录 |
| C02 自动控制 | 原生编排及真实 Actions 验证 auto 更新、pinned 跳过、resume 后交付当前来源；复用共享业务层 |
| C03 日常维护 | 原生样本中断 cleanup 后，schedule 先续做原计划再访问上游；同步部分失败仍保留安全清理结果且整体失败 |
| C04 五入口 | CLI、Node API、workflow_dispatch 共用五操作；无关参数拒绝，预览零写入；不增加 daily 公开命令 |
| C05 失败映射 | 普通来源失败与部分成功返回非零；pending/共享冲突停止后续写入，后续 cleanup 成功不能覆盖失败 |
| C06 原生通知 | 已只读核对账号 Actions 为 Email / Failed workflows only；未改变设置，邮箱实收未验证；文档提供官方设置路径 |
| C07 门禁与修订 | 更新与清理默认关闭且独立；disabled 返回当前配置修订和未应用，不读取旧生产 journal。每次读配置解析分支当前 head；真实旧事件重跑读取当前修订，生产 refs/variables 前后完全一致 |
| C08 交付核对 | 根 help、五个 Node 导出、CLI、Actions、README 与模块 ADR 对齐；保留 A/B 的历史验收记录 |

针对门禁与当前配置 5 项常规测试通过，工作流适配器 13 项常规测试通过，编排原生集成 1 项通过（0 跳过）；这些结果不替代后续统一验收及真实 GitHub 触发。

## 本地统一验收

统一入口 `node scripts/verify.mjs --out .verification/issue-86-local-1 --binary <sing-box 1.14.4 绝对路径>` 已通过，scope=`check-native`。summary 源码身份为 base commit `1ed2ab1af412199262e25c146b64938947580364`、`clean=false`、tracked diff SHA-256 `0cf6b59d570ee65f6413e48604cc3fe6646d07f9d1c5dce3a0dc68a65031e9c7`；该实现随后提交为 `24de37a`。Node.js `v26.13.0`、pnpm `10.33.2`、sing-box `1.14.4`，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。

- 常规检查：工具 115、Compiler 99、Pipeline 171，共 385 项通过；类型检查、构建和 workspace smoke 通过。
- 原生集成：Compiler 28、Pipeline 229，共 257 项通过。
- 合计 642 项通过，0 失败、0 取消、0 跳过。summary、日志和文件摘要保留在上述目录；未额外运行固定官方 Release 全量构建套件。
- 本地 Standards / Spec 对 `1ed2ab1...24de37a` 各自审查，均无 finding。独立复跑门禁与工作流 18 项通过。
- 真实 push 首次发现 workflow 的 job 级 env 不支持 `runner.temp`，未进入业务步骤；已将结果路径移到执行 step 的 env。修复后 actionlint `v1.7.12` 校验通过（禁用未安装的 shellcheck/pyflakes 外部检查）；这项工作流修复不计入此前 642 项源码覆盖。

## 真实 GitHub 隔离验收

探针限定一个同名 acceptance-issue-86-* 源码配置分支与产物分支。计划覆盖基线 push、pin、混合新增/换源/删除 push、resume 预览与实际执行、部分失败 push 和旧事件 rerun；来源为该隔离分支上的小型真实 CIDR 文件。保存原生事件、运行链接、实际配置修订及结果 artifact；前后核对生产 refs/Actions variables，最终清理本次隔离 refs。首轮真实 push 已触发，但在 workflow 解析阶段失败，无业务执行或 artifact；运行 [43906028541](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43906028541)。首轮两个隔离 refs 已清理，生产 refs/variables 前后不变，原始日志、诊断与证据保留在 `.verification/issue-86-github/attempt-1*`。第二轮 [43906598656](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43906598656) 已完成真实 push 启动、工具安装、失败摘要和 JSON artifact，但现有 `RULE_ARTIFACT_TOKEN` 返回 HTTP 401，规则业务未完成。第二轮两个隔离 refs 也已清理，`remaining=[]`、`cleanupErrors=[]`，生产 refs/variables 前后一致；证据为 `.verification/issue-86-github/attempt-2*`。当时完整自动混合变更、手工后续操作与旧事件重跑未完成。

用户随后选择准备独立隔离凭据。Actions 的 acceptance 目标改为只使用 `RULE_ACCEPTANCE_TOKEN`，不回落生产 Secret；生产路径仍使用 `RULE_ARTIFACT_TOKEN`。源码配置读取明确使用工作流自身 token，产物访问失败时保留已读取的配置修订。补充 20 项常规回归与 2 项原生入口/编排回归通过，0 跳过；typecheck、actionlint 通过。日志为 `.verification/issue-86-credential-regression.log` 与 `issue-86-credential-native.log`。这些补充修改晚于统一 642 项验证，最终 CI 覆盖见 PR。

第三轮使用已配置的独立 Secret，运行 [43908543388](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43908543388) 在读取配置后失败：探针复用对象时生成了正式解析器拒绝的 YAML aliases。已在 `444a801` 禁用别名生成，并在远端提交前调用正式解析器校验；代表性三规则配置本地解析及 typecheck 通过。第三轮两个 refs 删除成功，最终只读查询遇到一次网络 EOF，随后复核确认 refs 不存在、生产 refs/variables 不变。原始失败与补充复核记录保留在 `.verification/issue-86-github/attempt-3/`；该轮不计为生命周期通过。

第四轮基线 [43909174053](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43909174053) 已证实独立凭据能够写入隔离产物，三集实际交付记录均存在；其中 changing 记录 GitHub HTTP 422 `The request is taking too long to generate`，其余两集为 delivered，整体为 partial/exit 1。该轮未继续混合变更，不能算生命周期通过。两个隔离 refs 已清理，生产 refs/variables 前后不变；证据为 `.verification/issue-86-github/attempt-4/`。

对本轮不可变源码/产物对象的只读复查均成功，未复现该 422，原日志不能确定具体 endpoint。因此补齐 `ghJson` 失败的方法/路径诊断（不记录 query、body 或凭据，不重试写请求），25 项针对测试和 typecheck 通过。探针单运行/总等待上限改为 30/90 分钟，以容纳已观察到的真实远端耗时，业务断言不变。

### 第五轮：完整生命周期通过

实现固定为 `606b595d5f58a507371fd9a461ee53cf2479a74f`。一条真实 GitHub 生命周期测试通过（1 pass，0 fail/cancel/skip，约 26 分钟），覆盖以下七个阶段。表中两个 failure 是预期的业务失败，探针已断言部分成功、旧交付保留及正确的非零退出，不是跳过失败。

| 阶段 | 原生事件 / Actions 结论 | 观察结果 |
| --- | --- | --- |
| [baseline-push](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43912244882/attempts/1) | push / success | 三集均 delivered，配置修订匹配 push |
| [pin-fixed](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43913733332/attempts/1) | workflow_dispatch / success | fixed 控制状态变为 pinned |
| [mixed-push](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43914127847/attempts/1) | push / success | added 新增、changing 换源并更换版本、deleting 删除；fixed 跳过且保留固定版本 |
| [resume-preview](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43915129348/attempts/1) | workflow_dispatch / success | dryRun=true，产物 head 前后一致，零业务写入 |
| [resume-fixed](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43915305302/attempts/1) | workflow_dispatch / success | fixed 恢复 auto，并交付当前来源的新版本 |
| [partial-failure-push](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43915880368/attempts/1) | push / failure | changing 来源失败但保留旧交付；added 成功交付新版本，整体 partial/exit 1 |
| [old-event-rerun](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43914127847/attempts/2) | push / failure | 旧事件读取当前配置，保留已成功的 added 版本，不恢复已删除集；整体 partial/exit 1 |

旧事件 head 为 `c324085c4cb5ac56fde422d402844324997af84a`，第二次运行的实际配置修订为当前 `4f311c0f3d15ddcc631bf68390b16377f34ce4d5`。结果与新配置中的来源失败一致，证明没有重放旧配置。

两个本次拥有的隔离 refs 已删除，`remaining=[]`、`cleanupErrors=[]`。前后生产对照完全一致：源码 main=`1ed2ab1af412199262e25c146b64938947580364`，产物 main=`ae3cf588169226618eb30271f123c29608eb754a`，candidates=`2b74039505116d84688a379bfe04d25ae76f4350`；Actions variables 仍为空，更新和清理仍默认关闭。

原始证据保留在任务 worktree 的 `.verification/issue-86-github/attempt-5/`：`evidence.json` 含运行、配置修订和生产前后对照，各阶段目录保留下载的 JSON 与摘要，日志为 `../attempt-5.log`。前四轮失败及清理证据继续保留。此记录不宣称原生 schedule 或邮箱实收已经验证。

## 限制与部署边界

未观察原生 schedule 事件，定时编排通过本地真实业务层测试验证；cron 沿用每日 `23 20 * * *`（北京时间次日 04:23）。原生邮件按账号设置及 GitHub 平台行为工作，不承诺固定收件人、准时触发或邮箱必达。账号只读设置观察保存在本地 `.verification/issue-86-notifications.json`，不保存收件地址。

生产仍默认关闭，旧生产状态转换与正式启用需另行授权。本次只验证隔离目标，不以合并或 CI 成功表示生产已上线。最终 CI 与云端审查覆盖提交更新在 PR/工单交付记录中。
