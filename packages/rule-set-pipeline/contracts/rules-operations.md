# 配置驱动操作、状态与版本契约

本页描述 [Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 的应用服务结果及远端持久事实。它不是 Compiler 的输入契约；Compiler 继续消费 [Rule Subscription v2](rule-subscription-v2.md) 或固定 [Artifact Manifest v1](README.md)。

## 配置

正式配置为源码 main 当前 commit 的 `packages/rule-set-pipeline/config/rulesets.yml`。完整结构使用 `schemaVersion: 3`，字段为 `candidateRetentionDays`、`sources`、`target`、`ruleSets`。各层拒绝未知字段；`candidateRetentionDays` 必须为显式正整数，#84 不执行按天清理。

`target.repository` 固定为 `wangyingang/sing-box-rule-artifacts`；分支只能是 `main` 或受限 `acceptance-*`。`ruleSets` 中 ID 唯一，`source` 必须存在，`stablePath` 为互不重叠的 `stable/` 路径。显式空集合表示删除全部；缺少集合、读取失败或解析错误不能解释为删除。

获取机制与解析语义分别声明：GitHub Release 资产使用 `version: latest-release` 和 asset/checksum；固定 Git 分支输入使用 `version: git-branch`、branch/path。两者都接受已有的 `plain-yaml` 规则列表或 `cidr-text` 语义，不开放任意 YAML、动态插件或新格式。固定来源记录保存真实仓库、Release/commit 身份、输入文件、摘要和字节数；恢复使用登记的固定输入。

## 共同结果

四个服务返回 `RulesResult`，CLI `--json` 直接呈现相同业务结果：

| 字段 | 含义 |
| --- | --- |
| `operation`、`dryRun` | status/sync/pin/resume 及是否仅预览 |
| `configurationRevision`、`configurationOrigin` | 本次读到的正式 commit 和来源；草稿标记为 local-draft |
| `target` | 本次受限产物仓库与分支 |
| `status`、`exitCode` | success/partial/failed/pending；只有 success 为 0 |
| `results[]` | 每集的 `id`、结果、`changes`、`error`、`current`、`control`、`expectedSource` 和需要时的 `continueWith` |
| `observedHeads` | 能读到时返回日志与稳定分支的观察 head，不作为后续执行凭证 |
| `error` | 无法分配到单集的失败，或交付事实尚不能完成核实 |

逐集结果区分 delivered、unchanged、pinned-skipped、pinned、resumed、deleted、failed、pending、superseded、planned。正常固定跳过是成功；独立失败与成功并存为 partial；存在待核实提交或归属未知的隔离候选为 pending。`changes` 说明本次已完成或预览预计完成的变化。resume 后更新失败时，`automatic-updates-restored` 与 auto 控制说明解除固定已经持久化，不能把整次失败理解为仍被固定。

预览结果可以包含 `verified` 和 `unverified`，例如已验证来源、原生规则与订阅契约，但尚未验证远端发布及 HTTPS 回读。三种写操作的 dry-run 不持久保存任何状态，也不补做 pending 恢复。草稿仅允许 sync 预览；pin/resume 始终按正式配置核对。

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

## 一次性转换

schema 1 旧状态不能直接交给新编排，也不以缺失状态覆盖已有文件。内部转换须先核实旧状态、稳定交付和候选证据，再生成新模型；未知 schema 或无法安全归属的状态必须明确拒绝。转换预览只读，生产执行另行授权。

转换保留稳定 URL、规则字节、摘要和真实来源。有效人工固定映射为 pinned；已发生实质换源时旧固定不能复活。

本轮内部入口为 `src/rules-migration.ts` 的 `migrateRulesState({ context?, dryRun? })`，不从包入口或 CLI 导出，不接受草稿。单分支布局一次受控提交转换；双分支布局先保存旧日志维护检查点，再转换稳定交付元数据和回执，最后保存 schema 2 日志。稳定 JSON/SRS 字节不重写。

历史发布时间只从原不可变 `readback.json.publishedAt` 的有效 UTC ISO 值恢复，并在 `migration.timeEvidence` 记录证据地址。无法恢复时标记 `migrationPending`，保留现有交付与证据，不编造时间，也不把该候选当作正常可按年龄清理或选择的版本。

`quarantinedCandidates` 保存不完整候选的最小归属索引和原因，不伪造 build/source；同集显式删除会删除其文件与索引，归属无法确定时整体保持 pending 并阻止删除误报成功。`migration.pending` 列出转换时的待处理项；未完成候选的原字节保留，并在 `migration.quarantinedCandidates` 和旧状态审计快照中登记，旧任务由 head/维护隔离失效。转换结果区分 planned、converted 和 already-converted，返回 migration 审计。

转换的隔离验收和剩余项记录在 #84 交付证据；生产没有因代码合并而自动完成转换。候选年龄保留及 cleanup、push/schedule 和失败通知仍分别由 #85/#86 交付。
