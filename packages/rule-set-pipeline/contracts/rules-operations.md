# 配置驱动操作、状态与版本契约

本页描述 [Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84)、[Spec #85](https://github.com/wangyingang/sing-box-config-manager/issues/85) 与 [Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86) 的应用服务结果、自动运行边界及远端持久事实。它不是 Compiler 的输入契约；Compiler 继续消费 [Rule Subscription v2](rule-subscription-v2.md) 或固定 [Artifact Manifest v1](README.md)。

## 配置

正式配置为源码 main 当前 commit 的 `packages/rule-set-pipeline/config/rulesets.yml`。完整结构使用 `schemaVersion: 3`，字段为 `candidateRetentionDays`、`sources`、`target`、`ruleSets`。各层拒绝未知字段；`candidateRetentionDays` 必须为显式正整数，正式值为已确认的 30 天，由 cleanup 执行年龄保留策略。

`target.repository` 固定为 `wangyingang/sing-box-rule-artifacts`；分支只能是 `main` 或受限 `acceptance-*`。`ruleSets` 中 ID 唯一，`source` 必须存在，`stablePath` 为互不重叠的 `stable/` 路径。显式空集合表示删除全部；缺少集合、读取失败或解析错误不能解释为删除。

获取机制与解析语义分别声明：GitHub Release 资产使用 `version: latest-release` 和 asset/checksum；固定 Git 分支输入使用 `version: git-branch`、branch/path。两者都接受已有的 `plain-yaml` 规则列表或 `cidr-text` 语义，不开放任意 YAML、动态插件或新格式。固定来源记录保存真实仓库、Release/commit 身份、输入文件、摘要和字节数；恢复使用登记的固定输入。

## 共同结果

五个服务返回 `RulesResult`，CLI `--json` 直接呈现相同业务结果：

| 字段 | 含义 |
| --- | --- |
| `operation`、`dryRun` | status/sync/pin/resume/cleanup 及是否仅预览 |
| `configurationRevision`、`configurationOrigin` | 本次读到的正式 commit 和来源；草稿标记为 local-draft |
| `target` | 本次受限产物仓库与分支 |
| `status`、`exitCode` | success/disabled/partial/failed/pending；success 与 disabled 为 0，disabled 表示未应用 |
| `results[]` | 每集的 `id`、结果、`changes`、`error`、`current`、`control`、`expectedSource` 和需要时的 `continueWith` |
| `observedHeads` | 能读到时返回日志与稳定分支的观察 head，不作为后续执行凭证 |
| `error` | 无法分配到单集的失败，或交付事实尚不能完成核实 |
| `cleanup` | cleanup 的阶段、固化计划、保留/移除数量、其他引用与继续入口；无法盘点时可缺省 |

逐集结果区分 delivered、unchanged、pinned-skipped、pinned、resumed、deleted、failed、pending、superseded、planned。正常固定跳过是成功；独立失败与成功并存为 partial；存在待核实提交或归属未知的隔离候选为 pending。`changes` 说明本次已完成或预览预计完成的变化。resume 后更新失败时，`automatic-updates-restored` 与 auto 控制说明解除固定已经持久化，不能把整次失败理解为仍被固定。

预览结果可以包含 `verified` 和 `unverified`，例如已验证来源、原生规则与订阅契约，但尚未验证远端发布及 HTTPS 回读。四种写操作的 dry-run 不持久保存任何状态，也不补做 pending 恢复。草稿仅允许 sync 预览；pin/resume/cleanup 始终按正式配置核对。

## 环境门禁与自动运行

默认宿主读取源码 main 的当前正式配置。可信隔离环境可设置 `RULE_TARGET=acceptance-*`，并通过 `RULE_CONFIG_BRANCH` 选择 main 或与目标同名的配置分支；不接受其他分支，也不允许非 main 配置授权生产写入。每次调用及关键写入重读当前配置，不把事件 SHA、checkout 或历史结果作为重放凭证。

main 的 sync/pin/resume 写入受 `RULE_UPDATE_ENABLED` 控制，cleanup 写入独立受 `RULE_CLEANUP_ENABLED` 控制；只有值为 `true` 时启用，缺省关闭。环境门禁属于共享应用服务，CLI、Node 默认宿主和 Actions 一致；它不改变单集 auto/pinned。门禁关闭时返回配置修订、目标、`status: disabled`、`exitCode: 0` 和未应用原因。status 与 dry-run 允许只读检查，不因此获得写权限。

配置 push 调用完整 sync；schedule 正常先 sync 后 cleanup，存在活动维护时先 cleanup 续做，确认恢复可写后再同步。自动编排保留各次应用服务结果，并聚合退出码；独立单集失败不会回滚其他成功，也不能被之后的 cleanup 成功覆盖。共享状态未明或维护仍未完成时停止相关写入；pending/partial/failed 使整个运行非成功。手工 sync 不暗中清理，手工 cleanup 不更新上游，不公开 daily 或内部维护阶段入口。

同一目标的工作流使用同一 concurrency 组，业务远端校验继续生效。Actions 摘要和 JSON artifact 保存实际结果；GitHub 原生失败通知依赖账号设置，不承载独立业务邮件契约。通知设置和手工参数对照见[模块操作说明](../README.md#actions-自动与手工运行)。

## 查询

`getRulesStatus({ id? })` 额外返回 `rules[]`、`maintenance` 和存在时的 `quarantinedCandidates`。后者列出迁移隔离候选及其已知归属；归属未知时整体 pending。每集包含：

- `deliveryState`：delivered 或 not-delivered，首次构建失败不能伪装成存在旧版本。
- `expectedSource` 与 `current.source`：分别表示当前正式期望和实际交付来源；换源失败时两者可以不同。
- `control`：已接受的 auto/pinned 控制及 revision。
- `acceptedConfigurationRevision`、`configurationDifference`：上次接受修订及 add/change/delete/none 差异。
- `lifecycle`：present/deleting/deleted；待删除或待核实不等于删除已完成。
- `stableUrls`：当前交付文件的稳定地址。
- `candidates[]`：保留候选的 ID、可用版本身份/时间、真实来源、current、selectable 和不可选原因。
- `candidateCount`：可选择候选数量；不完整候选仍在列表中说明原因。
- `error`、`pendingOperation`：最近失败和待核实操作。

status 只读取，不登记操作、更新检查时间、恢复维护或发送通知。可选性检查以保留证据和当前订阅为依据；正式 pin 仍重新进行原生与兼容验证。

## 远端事实与版本身份

`pipeline/state.json` 使用 schema 2。`rules` 保存每集已接受定义、输入绑定、定义修订、配置修订、规则代次、lifecycle、控制与最近失败。`candidates` 保存构建、固定来源、证据及发布身份。`pendingDelivery` 登记一次未完成稳定写入，包含操作身份、配置修订、预期 stable head、目标规则事实与具体文件摘要/删除路径。状态写入还保存 `writeId`，以核实响应丢失的同一次提交。

输入绑定依据规范化来源与所选列表计算。它不含 source 别名或上游随后出现的新版本；定义修订另包含稳定路径与用途。控制只有 auto/pinned，不再由旧激活记录的双暂停布尔值与 resumes 叠加判定。

候选文件位于 `candidates/<id>/`，仍使用固定 commit 地址、Manifest、构建记录与 readback 证据。候选首次成功发布保存 UTC ISO 8601 `publishedAt`，并以时间和候选稳定短身份组成 `versionId`，例如 `2026-11-16T12:34:56.789Z~1234abcd`。时间相同的候选仍由完整身份区分，短身份冲突时延长；不覆盖旧候选。pin、resume、重试和再次交付不刷新原版本身份或时间。有效内容与构建条件未变时 sync 不新增候选。

`<stablePath>/activation.json` 是 schema 2 交付记录，保存逻辑 ID、candidateId、版本身份、真实来源、订阅和当前文件摘要。它描述实际交付，不承载更新控制。生产状态/候选位于 candidates 分支，稳定记录/文件位于 main；隔离目标共用同一 acceptance 分支。

稳定写入先登记操作，再核对配置、日志 head 和维护状态，按预期 parent 非强制更新目标 ref，并读回验证。响应丢失时先识别同一次操作；不明确时返回 pending。删除移除当前受管路径及候选，保留最小代次记录防止旧任务复活，不承诺清除 Git 历史或客户端缓存。

## 清理计划与恢复

`cleanupRuleHistory({ dryRun? })` 对整份受管状态执行维护，不接受规则 ID、版本或内部阶段参数。共同结果的 `cleanup` 包含：

| 字段 | 含义 |
| --- | --- |
| `phase` | preview/unchanged/isolated/prepared/readback/cleanup/completed/blocked，说明当前完成或待处理的位置 |
| `maintenanceId` | 存在时标识本次维护；恢复沿用同一身份 |
| `plan.candidateRetentionDays`、`plan.cleanupObservedAt`、`plan.cutoff` | 本次采用的天数、UTC 观察时间和截止时间 |
| `plan.decisions[]` | 每个候选的身份、已知版本/时间、retain/discard 及原因 |
| `plan.retain.candidateIds`、`plan.retain.active` | 保留候选集合和按 candidateId 明确指向的实际当前交付 |
| `plan.discard.candidateIds` | 本次可移除候选集合 |
| `plan.blockers`、`plan.retainedBytes`、`plan.hasCleanup` | 阻塞原因、保留候选与当前稳定文件的逻辑字节数及是否存在清理工作；字节数不含 Git 对象开销 |
| `plan.otherRefs`、`otherRefs` | 盘点时和结果中观察到的非受管引用；报告而不删除 |
| `retainedCandidateCount`、`removedCandidateCount` | 能确认时返回的保留/移除数量 |
| `continueWith` | 未完成时为 cleanup，CLI 显示 `pnpm rules cleanup` |

年龄按首次成功发布的 `publishedAt` 计算，UTC 连续 24 小时计一天。`publishedAt >= cutoff` 的完整候选保留；早于 cutoff 的候选仅在没有保护依赖时删除。当前交付、pin 目标、未决操作所需证据和最小控制/删除代次均受到保护。候选退出当前身份不更新时间或重新计时；未知历史时间不伪造、不按过期处理。

实际执行隔离写入后保存维护身份、时间边界和完整集合；中断恢复不重新计算删除计划。关键写入仍核对当前定义、控制、generation 和 Git heads，冲突时停止。新基线复制所有保留候选的完整依赖，并保留实际当前 candidate/version 指针。物理 commit 和证据 URL 可重写，业务 `versionId`、`publishedAt`、来源、稳定 URL 与规则字节不变。

切换前重跑 cleanup 复用或核实已准备对象；切换后继续回读、清理本次拥有且 head 一致的临时引用、恢复写入，不回滚旧基线。无法判定时保留隔离并返回 pending/failed。dry-run 只盘点已保存的状态与文件；`cleanup.unverified` 明示尚未执行的原生候选复验、新基线 HTTPS 回读和原子切换。存在活动维护时展示已固化计划，不恢复阶段、不写引用或 generation。status 在维护隔离期间报告 pending，并在当前检查点有计划时提供 cleanup 阶段、身份、截止时间与继续入口。

历史重建覆盖 candidates 和 main，隔离目标支持单分支。其他分支/标签只报告，它们可能使旧历史继续可达；不承诺 GitHub 立即物理回收。cleanup 不访问最新上游、不改变当前选择、不解除 pin；无候选到期且无待回收历史时不重复创建基线。

## 一次性转换

schema 1 旧状态不能直接交给新编排，也不以缺失状态覆盖已有文件。内部转换须先核实旧状态、稳定交付和候选证据，再生成新模型；未知 schema 或无法安全归属的状态必须明确拒绝。转换预览只读，生产执行另行授权。

转换保留稳定 URL、规则字节、摘要和真实来源。有效人工固定映射为 pinned；已发生实质换源时旧固定不能复活。

本轮内部入口为 `src/rules-migration.ts` 的 `migrateRulesState({ context?, dryRun? })`，不从包入口或 CLI 导出，不接受草稿。单分支布局一次受控提交转换；双分支布局先保存旧日志维护检查点，再转换稳定交付元数据和回执，最后保存 schema 2 日志。稳定 JSON/SRS 字节不重写。

历史发布时间只从原不可变 `readback.json.publishedAt` 的有效 UTC ISO 值恢复，并在 `migration.timeEvidence` 记录证据地址。无法恢复时标记 `migrationPending`，保留现有交付与证据，不编造时间，也不把该候选当作正常可按年龄清理或选择的版本。

`quarantinedCandidates` 保存不完整候选的最小归属索引和原因，不伪造 build/source；同集显式删除会删除其文件与索引，归属无法确定时整体保持 pending 并阻止删除误报成功。`migration.pending` 列出转换时的待处理项；未完成候选的原字节保留，并在 `migration.quarantinedCandidates` 和旧状态审计快照中登记，旧任务由 head/维护隔离失效。转换结果区分 planned、converted 和 already-converted，返回 migration 审计。

转换的隔离验收和剩余项记录在 #84 交付证据；生产没有因代码合并而自动完成转换。候选年龄保留、cleanup 与 push/schedule 按本页契约处理；生产更新和清理开关默认关闭，合并代码不会自动授权转换或启用。旧维护未决状态必须先核实，不能作为新 schema 的清理计划直接重放。
